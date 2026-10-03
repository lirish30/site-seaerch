import type { Fetcher } from "./crawler/crawl";

export interface MailDns { hasMx: boolean | null; hasSpf: boolean | null }
const UNKNOWN: MailDns = { hasMx: null, hasSpf: null };
const MX = 15, TXT = 16;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// null = not a plausible hostname. The value comes from stored data, so it is checked before it goes into a URL.
function normalise(domain: string): string | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = d.split(".");
  if (d.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return null;
  return d;
}

// Same deadline pattern as crawl.ts: racing it also covers fetchers that ignore the abort signal.
// Returns the answer data of `type`, or null when the lookup failed. NXDOMAIN (3) is a clean "none", SERVFAIL (2) is not.
async function query(name: string, type: "MX" | "TXT", fetch: Fetcher, ms: number): Promise<{ type: number; data: string }[] | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error("timeout")); }, ms); });
  deadline.catch(() => {});
  try {
    return await Promise.race([(async () => {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
        { signal: ctrl.signal, headers: { accept: "application/dns-json" } });
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return null; }
      const j = await res.json<{ Status?: unknown; Answer?: unknown }>();
      if (!j || typeof j !== "object" || (j.Status !== 0 && j.Status !== 3)) return null;
      if (j.Answer === undefined) return [];
      if (!Array.isArray(j.Answer)) return null;
      return j.Answer.filter((a): a is { type: number; data: string } => !!a && typeof a.type === "number" && typeof a.data === "string");
    })(), deadline]);
  } catch { return null; } finally { clearTimeout(timer); }
}

// TXT data arrives quoted, and long records as several quoted chunks.
function txtValue(data: string): string {
  const chunks = [...data.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return (chunks.length ? chunks.join("") : data).trim();
}
const isSpf = (a: { type: number; data: string }) => a.type === TXT && /^v=spf1(\s|$)/i.test(txtValue(a.data));

// Any positive wins; false needs every lookup to have succeeded.
const combine = (r: (boolean | null)[]) => (r.includes(true) ? true : r.every((x) => x === false) ? false : null);

/** Whether a domain has MX and SPF records, via Cloudflare DNS-over-HTTPS. Never throws; null = unknown. */
export async function lookupMailDns(domain: string, fetch: Fetcher, timeoutMs = 5000): Promise<MailDns> {
  try {
    const d = normalise(domain);
    if (!d) return UNKNOWN;
    // Mail usually lives at the apex, so a subdomain's parent is checked too.
    const names = d.split(".").length >= 3 ? [d, d.slice(d.indexOf(".") + 1)] : [d];
    const res = await Promise.all(names.map(async (n) => {
      const [mx, txt] = await Promise.all([query(n, "MX", fetch, timeoutMs), query(n, "TXT", fetch, timeoutMs)]);
      return { mx: mx && mx.some((a) => a.type === MX), spf: txt && txt.some(isSpf) };
    }));
    return { hasMx: combine(res.map((r) => r.mx)), hasSpf: combine(res.map((r) => r.spf)) };
  } catch { return UNKNOWN; }
}
