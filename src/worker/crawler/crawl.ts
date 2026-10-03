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

// One deadline covers headers AND (optionally) the body read; racing it also covers
// fetchers that ignore the abort signal.
// `x.redirect` defaults to "follow"; `x.anyBody` also reads non-HTML bodies (robots.txt); `x.maxBytes` stops reading
// after that many bytes; `x.accept` overrides the Accept header (text/html by default).
interface GetX { redirect?: RequestRedirect; anyBody?: boolean; maxBytes?: number; accept?: string }
async function readText(res: Response, maxBytes?: number): Promise<string> {
  if (!maxBytes || !res.body) return res.text();
  const reader = res.body.getReader(); const dec = new TextDecoder(); let out = "", n = 0;
  while (n < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength; out += dec.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return out;
}
async function get(url: string, o: Opts, method = "GET", readBody = false, x: GetX = {}): Promise<{ res: Response; body: string }> {
  const ctrl = new AbortController();
  const ms = o.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(`timeout after ${ms}ms`)); }, ms);
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        const res = await o.fetch(url, { method, redirect: x.redirect ?? "follow", signal: ctrl.signal, headers: { "user-agent": o.userAgent, accept: x.accept ?? "text/html" } });
        if (!(readBody && res.status < 400 && (x.anyBody || isHtml(res)))) { await res.body?.cancel().catch(() => {}); return { res, body: "" }; }
        return { res, body: await readText(res, x.maxBytes) };
      })(),
      deadline,
    ]);
  } finally { clearTimeout(timer); }
}

const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);
// Title markers are reliable; body markers are limited to challenge-only tokens so pages that merely
// embed reCAPTCHA on a contact form are not misread as blocked.
const CHALLENGE_TITLE = /just a moment|attention required|captcha|security check|access denied/i;
const CHALLENGE_BODY = /cf-browser-verification|cf_chl_opt|cf-challenge-running/i;
function isChallengePage(title: string | null, html: string): boolean {
  return (!!title && CHALLENGE_TITLE.test(title)) || CHALLENGE_BODY.test(html);
}

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");
const empty = (status: SiteStatus, error: string | null = null): CrawlResult =>
  ({ siteStatus: status, finalUrl: null, facts: null, contacts: [], pages: [], error });

const GONE = (s: number) => s === 404 || s === 410;
const SITEMAP_LINE = /^\s*sitemap\s*:\s*\S/im;
const PROBE: GetX = { anyBody: true, maxBytes: 64 * 1024, accept: "*/*" };
const titleOf = (html: string) => html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? null;

// null = could not tell. A 200 that serves HTML is a soft-404 (the homepage again), never a robots/sitemap file.
async function checkRobots(origin: string, o: Opts): Promise<{ present: boolean | null; sitemapDeclared: boolean }> {
  try {
    const { res, body } = await get(`${origin}/robots.txt`, o, "GET", true, PROBE);
    if (GONE(res.status)) return { present: false, sitemapDeclared: false };
    if (res.status !== 200) return { present: null, sitemapDeclared: false };
    // Some servers send plain-text robots.txt as text/html: no <html> tag means it is the file, not a page.
    if (isHtml(res) && (/<html/i.test(body) || !body.trim())) return { present: false, sitemapDeclared: false };
    return { present: true, sitemapDeclared: SITEMAP_LINE.test(body) };
  } catch { return { present: null, sitemapDeclared: false }; }
}
// true = a sitemap, false = definitely none here (404/410 or an ordinary HTML page), null = could not tell.
async function probeSitemap(url: string, o: Opts): Promise<boolean | null> {
  try {
    const { res, body } = await get(url, o, "GET", true, PROBE);
    if (GONE(res.status)) return false;
    if (res.status !== 200) return null;
    if (/<urlset|<sitemapindex/i.test(body)) return true;
    if (isHtml(res)) return isChallengePage(titleOf(body), body) ? null : false;
    return /xml|text\/plain/i.test(res.headers.get("content-type") ?? "") ? true : null;
  } catch { return null; }
}
// Common sitemap locations, tried in turn only while the answer is still open. Any success wins; false needs every probe to say "none".
async function checkSitemap(origin: string, o: Opts, declared: boolean): Promise<boolean | null> {
  if (declared) return true;
  const results: (boolean | null)[] = [];
  for (const path of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]) {
    const r = await probeSitemap(`${origin}${path}`, o);
    if (r === true) return true;
    results.push(r);
  }
  return results.includes(null) ? null : false;
}
const SCRIPT_REDIRECT = /(?<![a-z0-9_$])(?:location\s*\.\s*(?:replace|assign)\s*\(|location(?:\s*\.\s*href)?\s*=(?!=)|top\s*\.\s*location)/i;
// true = sends visitors to https, false = serves the page over plain http, null = could not tell.
async function checkHttpRedirect(host: string, o: Opts): Promise<boolean | null> {
  try {
    const base = `http://${host}/`;
    const { res, body } = await get(base, o, "GET", true, { redirect: "manual" });
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      // Only a redirect that lands on https counts; one that goes to another http address could still end on https.
      return loc && new URL(loc, base).protocol === "https:" ? true : null;
    }
    if (res.status !== 200 || !isHtml(res)) return null;
    // A meta-refresh or script redirect is one we can't follow, and a bot-check page says nothing about the site: both prove nothing.
    if (/http-equiv\s*=\s*["']?refresh/i.test(body) || SCRIPT_REDIRECT.test(body) || isChallengePage(titleOf(body), body)) return null;
    return false;
  } catch { return null; }
}

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
  let home: Response | null = null; let homeBody = ""; let homeUrl = ""; let lastErr: string | null = null;
  for (const c of candidates) {
    try {
      const r = await get(c, o, "GET", true);
      // An http fallback that errors after https threw: report the original connection error.
      if (lastErr && r.res.status >= 400) break;
      home = r.res; homeBody = r.body; homeUrl = r.res.url || c;
      break;
    } catch (e) { lastErr = (e as Error).message; }
  }
  if (!home) return empty("unreachable", lastErr ?? "fetch failed");
  // Bot protection: the site exists but refuses automated visitors. Keep the URL so PageSpeed can still run.
  const blocked = (why: string): CrawlResult => ({ ...empty("blocked", why), finalUrl: homeUrl });
  if (BLOCKED_STATUSES.has(home.status)) return blocked(`HTTP ${home.status}`);
  if (home.status >= 400) return empty("unreachable", `HTTP ${home.status}`);
  if (!home.headers.get("content-type")) return blocked("Homepage has no content-type");
  if (!isHtml(home)) return empty("unreachable", `Homepage is ${home.headers.get("content-type")}`);
  // A redirect that lands on a social/listing page is not a real website.
  if (isSocialOnlyUrl(homeUrl)) return empty("no_website");

  const homeHtml = homeBody;
  const homeFacts = extractPage(homeHtml, homeUrl);
  if (isChallengePage(homeFacts.title, homeHtml)) return blocked("Homepage is a bot-check challenge");
  if (homeFacts.isParked) return { ...empty("parked"), finalUrl: homeUrl };

  const pages: CrawlResult["pages"] = [{ url: homeUrl, status: home.status, html: homeHtml }];
  const facts: { url: string; f: PageFacts }[] = [{ url: homeUrl, f: homeFacts }];

  const targets = pickCrawlTargets(homeFacts.internalLinks, homeUrl, (o.maxPages ?? 6) - 1);
  for (const t of targets) {
    try {
      const { res: r, body: h } = await get(t, o, "GET", true);
      if (r.status >= 400 || !isHtml(r)) continue;
      pages.push({ url: t, status: r.status, html: h });
      facts.push({ url: t, f: extractPage(h, t) });
    } catch { /* skip page */ }
  }

  const crawled = new Set(pages.map((p) => p.url));
  const toCheck = homeFacts.internalLinks.filter((l) => !crawled.has(l)).slice(0, MAX_BROKEN_CHECKS);
  let broken = 0;
  const hu = new URL(homeUrl);
  // A site on a non-default port has no meaningful plain-http twin, so that probe is skipped (null).
  const [siteFiles, httpRedirect] = await Promise.all([
    checkRobots(hu.origin, o).then(async (robots) => ({ robots, sitemap: await checkSitemap(hu.origin, o, robots.sitemapDeclared) })),
    hu.protocol === "https:" && !hu.port ? checkHttpRedirect(hu.host, o) : Promise.resolve(null),
    ...toCheck.map(async (l) => {
      try { const { res: r } = await get(l, o, "HEAD"); if (r.status === 404 || r.status === 410) broken++; } catch { /* ignore */ }
    }),
  ]);

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
      platform: homeFacts.platform,
      h1Count: homeFacts.h1Count,
      wordCount: homeFacts.wordCount,
      imageCount: homeFacts.imageCount,
      imagesMissingAlt: homeFacts.imagesMissingAlt,
      hasPhone: facts.some((x) => x.f.hasPhoneNumber),
      hasTelLink: facts.some((x) => x.f.hasTelLink),
      hasLocalBusinessSchema: facts.some((x) => x.f.hasLocalBusinessSchema),
      mixedContentCount: homeFacts.mixedContentCount,
      datedBuildMarkers: [...new Set(homeFacts.datedBuildMarkers)],
      isLikelyJsRendered: homeFacts.isLikelyJsRendered,
      hasRobotsTxt: siteFiles.robots.present,
      hasSitemap: siteFiles.sitemap,
      httpRedirectsToHttps: httpRedirect,
    },
  };
}
