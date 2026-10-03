import type { Fetcher } from "./crawler/crawl";
import type { Contact } from "./types";

export interface MailDns { hasMx: boolean | null; hasSpf: boolean | null }
export const UNKNOWN_MAIL_DNS: MailDns = { hasMx: null, hasSpf: null };
export const DNS_TIMEOUT_MS = 5000;
const MX = 15, TXT = 16;

// Domains a business can't own mail on: public suffixes and hosted-site builders. An address "at" one of these
// says nothing about the business, and a site hosted on one must never be judged by the platform's DNS.
// Public suffixes are denied only as an exact match (ace.co.uk is a real business domain; co.uk is not). Platform
// domains are denied along with everything under them: joe.wixsite.com is the platform's name space, not Joe's own domain.
export const PUBLIC_SUFFIXES: readonly string[] = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "com.mx", "co.jp", "co.in",
  "com.sg", "co.id", "com.tr", "com.ar", "com.co", "com.pe", "com.ph", "com.my", "com.hk",
];
export const PLATFORM_SUFFIXES: readonly string[] = [
  "wixsite.com", "wixstudio.io", "editorx.io", "squarespace.com", "myshopify.com", "godaddysites.com", "weebly.com", "weeblysite.com",
  "webflow.io", "netlify.app", "vercel.app", "pages.dev", "github.io", "gitlab.io", "herokuapp.com", "web.app", "firebaseapp.com",
  "azurewebsites.net", "blogspot.com", "wordpress.com", "carrd.co", "jimdosite.com", "site123.me", "mystrikingly.com", "strikingly.com",
  "yolasite.com", "webnode.page", "multiscreensite.com", "business.site", "square.site",
];
export const HOSTED_SUFFIXES: readonly string[] = [...PUBLIC_SUFFIXES, ...PLATFORM_SUFFIXES];
const DENIED = new Set(HOSTED_SUFFIXES);
const isDenied = (d: string) => DENIED.has(d) || PLATFORM_SUFFIXES.some((p) => d.endsWith(`.${p}`));

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
      const j = await res.json<{ Status?: unknown; TC?: unknown; Answer?: unknown }>();
      if (!j || typeof j !== "object" || (j.Status !== 0 && j.Status !== 3) || j.TC === true) return null;
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

// RFC 7505 null MX ("0 .") is a domain announcing it takes no mail, not a mail server.
const isMx = (a: { type: number; data: string }) => a.type === MX && !/^\d+\s+\.$/.test(a.data.trim());

/** Whether a domain has MX and SPF records, via Cloudflare DNS-over-HTTPS. Never throws; null = unknown. Looks up exactly the name given. */
export async function lookupMailDns(domain: string, fetch: Fetcher, timeoutMs = DNS_TIMEOUT_MS): Promise<MailDns> {
  try {
    const d = normalise(domain);
    if (!d) return UNKNOWN_MAIL_DNS;
    const [mx, txt] = await Promise.all([query(d, "MX", fetch, timeoutMs), query(d, "TXT", fetch, timeoutMs)]);
    return { hasMx: mx && mx.some(isMx), hasSpf: txt && txt.some(isSpf) };
  } catch { return UNKNOWN_MAIL_DNS; }
}

/**
 * The domain whose mail records may be claimed about: that of a crawled email address which belongs to the site
 * (its own host, or a parent of it such as ace.com for shop.ace.com), never a free-mail, public-suffix or hosted-platform
 * domain. null = no evidence the business uses its own domain for email, so nothing may be said about its mail.
 */
export function siteMailDomain(site: string | null, contacts: Pick<Contact, "type" | "value" | "person_name" | "confidence">[]): string | null {
  if (!site) return null;
  let host: string;
  try { host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  const found: { d: string; named: boolean; confidence: number }[] = [];
  for (const c of contacts) {
    if (c.type !== "email" || !c.value.includes("@")) continue;
    const d = normalise(c.value.slice(c.value.lastIndexOf("@") + 1));
    if (d && !isDenied(d) && (d === host || host.endsWith(`.${d}`))) found.push({ d, named: !!c.person_name, confidence: c.confidence });
  }
  // Array.sort is stable, so ties keep the crawl order.
  found.sort((a, b) => Number(b.named) - Number(a.named) || b.confidence - a.confidence);
  return found[0]?.d ?? null;
}
