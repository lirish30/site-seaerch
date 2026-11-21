// Domain expiry from RDAP (rdap.org bootstraps to the right registry). Pure: the fetch function is injected.
// The answer says which of three things happened, because the caller must treat them differently: a date was found; the registry answered but has no date (not found, or a record
// with no expiration event), which is worth remembering for a week; or the lookup failed (rate limit, a server error, silence, an unreadable answer), which must be tried again soon.
// Nothing here is an error to show anyone.

const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const RDAP_TIMEOUT_MS = 5_000;

/** The YYYY-MM-DD of the first usable "expiration" event, or null. */
export function parseRdapExpiry(json: unknown): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const { eventAction, eventDate } = event as { eventAction?: unknown; eventDate?: unknown };
    if (eventAction !== "expiration" || typeof eventDate !== "string") continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(eventDate);
    if (!m || Number.isNaN(Date.parse(eventDate))) continue;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    // Date.UTC rolls an impossible day over, so a round trip catches 2027-02-30 and 2027-13-45.
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) continue;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

export type DomainLookup = { kind: "found"; expiresOn: string } | { kind: "unknown" } | { kind: "failed" };

/**
 * Asks the registry (through rdap.org) when the domain expires. `unknown`: a clean 404, or a document with no usable expiration event (also a name that is not a domain, which is never asked).
 * `failed`: any other non-OK answer (429, 5xx), a throw, a timeout, or a body that is not JSON.
 */
export async function fetchDomainExpiry(domain: string, fetchFn: typeof fetch): Promise<DomainLookup> {
  if (!DOMAIN_SHAPE.test(domain)) return { kind: "unknown" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
  try {
    const res = await fetchFn(`https://rdap.org/domain/${domain}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json" },
    });
    if (res.status === 404) return { kind: "unknown" };
    if (!res.ok) return { kind: "failed" };
    const expiresOn = parseRdapExpiry(await res.json());
    return expiresOn === null ? { kind: "unknown" } : { kind: "found", expiresOn };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
