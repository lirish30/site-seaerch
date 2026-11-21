// Domain expiry from RDAP (rdap.org bootstraps to the right registry). Pure: the fetch function is injected.
// Any failure is a null; the caller treats "unknown" as "nothing to say", never as an error to show.

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

export async function fetchDomainExpiry(domain: string, fetchFn: typeof fetch): Promise<string | null> {
  if (!DOMAIN_SHAPE.test(domain)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
  try {
    const res = await fetchFn(`https://rdap.org/domain/${domain}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json" },
    });
    if (!res.ok) return null;
    return parseRdapExpiry(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
