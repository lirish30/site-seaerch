import type { ContactInput, SiteStatus } from "../types";
import type { CrawlFacts } from "../scoring/scorer";
import { extractPage, isSocialOnlyUrl, pickCrawlTargets, type PageFacts } from "./extract";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface CrawlResult {
  siteStatus: SiteStatus; finalUrl: string | null; facts: CrawlFacts | null; contacts: ContactInput[];
  pages: { url: string; status: number; html: string }[]; error: string | null;
}
interface Opts { fetch: Fetcher; userAgent: string; now: Date; timeoutMs?: number; maxPages?: number; }

const MAX_BROKEN_CHECKS = 15;

async function get(url: string, o: Opts, method = "GET") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  try {
    return await o.fetch(url, { method, redirect: "follow", signal: ctrl.signal, headers: { "user-agent": o.userAgent, accept: "text/html" } });
  } finally { clearTimeout(t); }
}

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");
const empty = (status: SiteStatus, error: string | null = null): CrawlResult =>
  ({ siteStatus: status, finalUrl: null, facts: null, contacts: [], pages: [], error });

function normalize(url: string): string {
  const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  u.hash = ""; if (!u.pathname) u.pathname = "/";
  return u.toString();
}

export async function crawlSite(websiteUrl: string | null, o: Opts): Promise<CrawlResult> {
  if (!websiteUrl || !websiteUrl.trim()) return empty("no_website");
  let start: string;
  try { start = normalize(websiteUrl.trim()); } catch { return empty("no_website"); }
  if (isSocialOnlyUrl(start)) return empty("no_website");

  const candidates = start.startsWith("http://") ? [start.replace("http://", "https://"), start] : [start, start.replace("https://", "http://")];
  let home: Response | null = null; let homeUrl = ""; let lastErr: string | null = null;
  for (const c of candidates) {
    try {
      const r = await get(c, o);
      // An http fallback that errors after https threw: report the original connection error.
      if (lastErr && r.status >= 400) break;
      home = r; homeUrl = r.url || c;
      break;
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!home) return empty("unreachable", lastErr ?? "fetch failed");
  if (home.status >= 400) return empty("unreachable", `HTTP ${home.status}`);
  if (!isHtml(home)) return empty("unreachable", `Homepage is ${home.headers.get("content-type")}`);
  // A redirect that lands on a social/listing page is not a real website.
  if (isSocialOnlyUrl(homeUrl)) return empty("no_website");

  let homeHtml: string;
  try { homeHtml = await home.text(); } catch (e) { return empty("unreachable", (e as Error).message); }
  const homeFacts = extractPage(homeHtml, homeUrl);
  if (homeFacts.isParked) return { ...empty("parked"), finalUrl: homeUrl };

  const pages: CrawlResult["pages"] = [{ url: homeUrl, status: home.status, html: homeHtml }];
  const facts: { url: string; f: PageFacts }[] = [{ url: homeUrl, f: homeFacts }];

  const targets = pickCrawlTargets(homeFacts.internalLinks, homeUrl, (o.maxPages ?? 6) - 1);
  for (const t of targets) {
    try {
      const r = await get(t, o);
      if (r.status >= 400 || !isHtml(r)) continue;
      const h = await r.text();
      pages.push({ url: t, status: r.status, html: h });
      facts.push({ url: t, f: extractPage(h, t) });
    } catch { /* skip page */ }
  }

  const crawled = new Set(pages.map((p) => p.url));
  const toCheck = homeFacts.internalLinks.filter((l) => !crawled.has(l)).slice(0, MAX_BROKEN_CHECKS);
  let broken = 0;
  await Promise.all(toCheck.map(async (l) => {
    try { const r = await get(l, o, "HEAD"); if (r.status === 404 || r.status === 410) broken++; } catch { /* ignore */ }
  }));

  const today = o.now.toISOString().slice(0, 10);
  const allDates = [...new Set(facts.flatMap((x) => x.f.dates))].filter((d) => d <= today).sort();
  const pastEvents = [...new Set(facts.flatMap((x) => x.f.eventDates))].filter((d) => d < today).sort();
  const years = facts.map((x) => x.f.copyrightYear).filter((y): y is number => y !== null);

  const contacts: ContactInput[] = [];
  const seenEmail = new Set<string>();
  for (const { url, f } of facts) {
    for (const e of f.emails) {
      if (seenEmail.has(e.value)) continue; seenEmail.add(e.value);
      contacts.push({ type: "email", value: e.value, source_url: url, person_name: e.personName, role: e.role, confidence: e.personName ? 0.9 : 0.7 });
    }
  }
  const formPage = facts.find((x) => x.f.hasForm && /contact/i.test(x.url)) ?? facts.find((x) => x.f.hasForm);
  if (formPage) contacts.push({ type: "form", value: formPage.url, source_url: formPage.url, person_name: null, role: null, confidence: 0.6 });
  const phone = facts.flatMap((x) => x.f.phones)[0];
  if (phone) contacts.push({ type: "phone", value: phone, source_url: homeUrl, person_name: null, role: null, confidence: 0.5 });
  for (const s of [...new Set(facts.flatMap((x) => x.f.socials))].slice(0, 5))
    contacts.push({ type: "social", value: s, source_url: homeUrl, person_name: null, role: null, confidence: 0.4 });

  return {
    siteStatus: "ok", finalUrl: homeUrl, pages, error: null, contacts,
    facts: {
      https: homeUrl.startsWith("https://"),
      hasTitle: !!homeFacts.title,
      hasMetaDescription: !!homeFacts.metaDescription,
      hasViewport: homeFacts.hasViewport,
      hasContactForm: !!formPage,
      emailCount: seenEmail.size,
      copyrightYear: years.length ? Math.max(...years) : null,
      latestContentDate: allDates.at(-1) ?? null,
      pastEventDates: pastEvents,
      brokenLinkCount: broken,
    },
  };
}
