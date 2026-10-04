import type { ContactInput, PageKind, SiteStatus } from "../types";
import type { CrawlFacts } from "../scoring/scorer";
import { classifyLinks, extractPage, isSocialOnlyUrl, pickCrawlTargets, type PageFacts } from "./extract";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface CrawlResult {
  siteStatus: SiteStatus; finalUrl: string | null; facts: CrawlFacts | null; contacts: ContactInput[];
  pages: { url: string; status: number; html: string }[]; error: string | null;
  links: Partial<Record<PageKind, string>>;
}
interface Opts {
  fetch: Fetcher; userAgent: string; now: Date; timeoutMs?: number; maxPages?: number;
  /** Homepage as rendered by a real browser: catches JS-built forms/nav and gets past some bot walls. */
  rendered?: { url: string; html: string } | null;
}

const MAX_BROKEN_CHECKS = 15;

// One deadline covers headers AND (optionally) the body read; racing it also covers
// fetchers that ignore the abort signal.
async function get(url: string, o: Opts, method = "GET", readBody = false): Promise<{ res: Response; body: string }> {
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
        const res = await o.fetch(url, { method, redirect: "follow", signal: ctrl.signal, headers: { "user-agent": o.userAgent, accept: "text/html" } });
        const body = readBody && res.status < 400 && isHtml(res) ? await res.text() : "";
        return { res, body };
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
  ({ siteStatus: status, finalUrl: null, facts: null, contacts: [], pages: [], error, links: {} });

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
  // A browser render that loaded a real page beats a plain fetch that failed or hit a bot wall.
  const r = o.rendered && o.rendered.html.length > 500 ? o.rendered : null;
  const rFacts = r ? extractPage(r.html, r.url) : null;
  const renderUsable = !!r && !!rFacts && !isChallengePage(rFacts.title, r.html) && !isSocialOnlyUrl(r.url);
  let homeStatus = home?.status ?? 200;
  const failure = ((): CrawlResult | null => {
    if (!home) return empty("unreachable", lastErr ?? "fetch failed");
    // Bot protection: the site exists but refuses automated visitors. Keep the URL so PageSpeed can still run.
    const blocked = (why: string): CrawlResult => ({ ...empty("blocked", why), finalUrl: homeUrl });
    if (BLOCKED_STATUSES.has(home.status)) return blocked(`HTTP ${home.status}`);
    if (home.status >= 400) return empty("unreachable", `HTTP ${home.status}`);
    if (!home.headers.get("content-type")) return blocked("Homepage has no content-type");
    if (!isHtml(home)) return empty("unreachable", `Homepage is ${home.headers.get("content-type")}`);
    // A redirect that lands on a social/listing page is not a real website.
    if (isSocialOnlyUrl(homeUrl)) return empty("no_website");
    if (isChallengePage(extractPage(homeBody, homeUrl).title, homeBody)) return blocked("Homepage is a bot-check challenge");
    return null;
  })();
  if (failure) {
    if (failure.siteStatus === "no_website" || !renderUsable) return failure;
    homeUrl = r!.url; homeBody = r!.html; homeStatus = 200;
  }

  const homeHtml = homeBody;
  const rawFacts = extractPage(homeHtml, homeUrl);
  const homeFacts = rFacts && renderUsable ? mergeFacts(rawFacts, rFacts) : rawFacts;
  if (homeFacts.isParked && rawFacts.isParked) return { ...empty("parked"), finalUrl: homeUrl };

  const pages: CrawlResult["pages"] = [{ url: homeUrl, status: homeStatus, html: homeHtml }];
  const facts: { url: string; f: PageFacts }[] = [{ url: homeUrl, f: homeFacts }];

  const targets = pickCrawlTargets(homeFacts.anchors, homeUrl, (o.maxPages ?? 8) - 1);
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
  await Promise.all(toCheck.map(async (l) => {
    try { const { res: r } = await get(l, o, "HEAD"); if (r.status === 404 || r.status === 410) broken++; } catch { /* ignore */ }
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
  const formPage = facts.find((x) => (x.f.hasForm || x.f.hasEmbeddedForm) && /contact/i.test(x.url))
    ?? facts.find((x) => x.f.hasForm || x.f.hasEmbeddedForm);
  if (formPage) contacts.push({ type: "form", value: formPage.url, source_url: formPage.url, person_name: null, role: null, confidence: 0.6 });
  const phone = facts.flatMap((x) => x.f.phones)[0];
  if (phone) contacts.push({ type: "phone", value: phone, source_url: homeUrl, person_name: null, role: null, confidence: 0.5 });
  for (const s of [...new Set(facts.flatMap((x) => x.f.socials))].slice(0, 5))
    contacts.push({ type: "social", value: s, source_url: homeUrl, person_name: null, role: null, confidence: 0.4 });

  const any = (k: keyof PageFacts) => facts.some((x) => !!x.f[k]);
  const links = classifyLinks(facts.flatMap((x) => x.f.anchors), homeUrl);
  const careers = facts.flatMap((x) => x.f.externalCareers)[0];
  if (careers && !links.careers) links.careers = careers;
  const kindsFound = new Set<PageKind>(Object.keys(links) as PageKind[]);
  if (any("hasBooking")) kindsFound.add("booking");
  const imgs = facts.reduce((s, x) => s + x.f.imageCount, 0);
  const noAlt = facts.reduce((s, x) => s + x.f.imagesMissingAlt, 0);

  return {
    siteStatus: "ok", finalUrl: homeUrl, pages, error: null, contacts, links,
    facts: {
      hasNav: homeFacts.hasNav, navItemCount: homeFacts.navItemCount, hasFooter: homeFacts.hasFooter,
      hasH1: homeFacts.hasH1, hasCta: any("hasCta"), hasSocialProof: any("hasSocialProof"), hasBooking: any("hasBooking"),
      hasOpenGraph: homeFacts.hasOpenGraph, schemaTypes: [...new Set(facts.flatMap((x) => x.f.schemaTypes))],
      homeWordCount: homeFacts.wordCount, imagesMissingAltPct: imgs ? noAlt / imgs : 0,
      phoneVisible: homeFacts.phones.length > 0 || /href="tel:/i.test(homeHtml),
      pageKinds: [...kindsFound].sort(), rendered: renderUsable,
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

/** Union of what the raw HTML and the browser-rendered DOM show; the render wins on structure. */
function mergeFacts(raw: PageFacts, r: PageFacts): PageFacts {
  const uniq = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  return {
    ...r,
    title: r.title ?? raw.title, metaDescription: raw.metaDescription ?? r.metaDescription,
    hasViewport: raw.hasViewport || r.hasViewport, hasForm: raw.hasForm || r.hasForm,
    emails: uniq([...raw.emails, ...r.emails], (e) => e.value),
    phones: [...new Set([...raw.phones, ...r.phones])], socials: [...new Set([...raw.socials, ...r.socials])],
    copyrightYear: Math.max(raw.copyrightYear ?? 0, r.copyrightYear ?? 0) || null,
    dates: [...new Set([...raw.dates, ...r.dates])], eventDates: [...new Set([...raw.eventDates, ...r.eventDates])],
    internalLinks: [...new Set([...raw.internalLinks, ...r.internalLinks])],
    anchors: uniq([...r.anchors, ...raw.anchors], (a) => a.url),
    isParked: raw.isParked && r.isParked,
    hasNav: raw.hasNav || r.hasNav, navItemCount: Math.max(raw.navItemCount, r.navItemCount),
    hasFooter: raw.hasFooter || r.hasFooter, hasH1: raw.hasH1 || r.hasH1, hasCta: raw.hasCta || r.hasCta,
    hasSocialProof: raw.hasSocialProof || r.hasSocialProof, hasBooking: raw.hasBooking || r.hasBooking,
    hasEmbeddedForm: raw.hasEmbeddedForm || r.hasEmbeddedForm, hasOpenGraph: raw.hasOpenGraph || r.hasOpenGraph,
    schemaTypes: [...new Set([...raw.schemaTypes, ...r.schemaTypes])],
    wordCount: Math.max(raw.wordCount, r.wordCount),
    externalCareers: [...new Set([...raw.externalCareers, ...r.externalCareers])],
  };
}
