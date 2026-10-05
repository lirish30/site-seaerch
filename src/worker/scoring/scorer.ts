import type { AiReview, AuditCategory, CategoryScores, Finding, FindingCode, Offer, PageKind, Platform, SiteStatus } from "../types";
import { AI_BLEND, CATEGORY_WEIGHTS, DEDUCTIONS as D, SITE_STATUS_SCORE, THRESHOLDS as T, severityFor } from "./config";
import { labelsFor } from "./labels";
import { NICHES, guessNiche, type NicheKey } from "../audit/rubrics";

export interface CrawlFacts {
  https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean;
  hasContactForm: boolean; emailCount: number; copyrightYear: number | null;
  latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number;
  hasNav: boolean; navItemCount: number; hasFooter: boolean; hasH1: boolean; hasCta: boolean;
  hasSocialProof: boolean; hasBooking: boolean; hasOpenGraph: boolean; schemaTypes: string[];
  homeWordCount: number; imagesMissingAltPct: number; phoneVisible: boolean;
  pageKinds: PageKind[]; rendered: boolean;
  platform: Platform;
  // Homepage facts read from the DOM (visible words; content images, and those with no alt attribute at all).
  h1Count: number; wordCount: number; imageCount: number; imagesMissingAlt: number;
  hasPhone: boolean; hasTelLink: boolean; hasLocalBusinessSchema: boolean; mixedContentCount: number;
  datedBuildMarkers: string[];
  // Static HTML only (no usable browser render): when true, "X is absent" findings are suppressed because the page may fill X in with JavaScript.
  isLikelyJsRendered: boolean;
  // null = could not determine, which never produces a finding.
  hasRobotsTxt: boolean | null; hasSitemap: boolean | null; httpRedirectsToHttps: boolean | null;
}
export interface PageSpeedFacts {
  performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean;
  // null = Lighthouse didn't return that category (never a real 0).
  seoScore: number | null; accessibilityScore: number | null; seoIssueIds: string[]; accessibilityIssueIds: string[];
}
/** Mail records of a domain the site lists an email at; null = could not determine. */
export interface MailDnsFacts { hasMx: boolean | null; hasSpf: boolean | null; }
/** Measured in a real 390px-wide browser: the ground truth for "works on a phone". */
export interface MobileFacts { overflowX: boolean; smallTextPct: number; }
export interface BusinessSignals { category: string | null; rating: number | null; reviewCount: number | null; }

export interface ScoreInput {
  siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date;
  mobile?: MobileFacts | null; review?: AiReview | null; business?: BusinessSignals;
  mailDns?: MailDnsFacts | null;
}
export interface ScoreResult {
  /** Opportunity (0-100, higher = better lead). */
  score: number; health: number | null; categoryScores: CategoryScores; niche: NicheKey;
  findings: Finding[]; offer: Offer; lowPriority: boolean;
}

const RECOMMEND: Partial<Record<FindingCode, string>> = {
  no_viewport: "Rebuild the layout to be responsive so it adapts to phone screens.",
  mobile_overflow: "Fix elements wider than the screen so phone visitors don't have to scroll sideways.",
  not_mobile_friendly: "Make text and buttons large enough to read and tap on a phone.",
  small_text_mobile: "Increase body text to at least 16px on mobile.",
  slow_mobile: "Compress images, defer heavy scripts and use modern hosting/caching to cut load time.",
  meh_mobile: "Optimize images and scripts to bring mobile load times under 3 seconds.",
  slow_lcp: "Make the main hero image/text load first (preload, compress, avoid sliders).",
  layout_shift: "Reserve space for images, fonts and banners so the page stops jumping while loading.",
  stale_content: "Publish fresh updates (news, projects, offers) so visitors and Google see an active business.",
  old_copyright: "Update the footer and review the site for other outdated details.",
  past_events: "Remove past events or move them to an archive; keep the calendar current.",
  thin_homepage: "Expand the homepage with services, proof and a clear next step.",
  missing_niche_page: "Add this page; it's one customers in this industry look for before contacting a business.",
  no_contact_path: "Add a short contact form plus a visible phone and email on every page.",
  no_cta: "Add one clear primary button (call, book, get a quote) above the fold and repeat it down the page.",
  no_phone_visible: "Put a tap-to-call phone number in the header.",
  no_social_proof: "Show reviews or testimonials near the call to action.",
  no_nav: "Add a clear navigation menu linking to every key page.",
  no_footer: "Add a footer with address, hours, phone, email and key links.",
  broken_links: "Fix or remove links that lead to missing pages.",
  no_https: "Install an SSL certificate so browsers stop showing a 'Not secure' warning.",
  no_title_or_meta: "Write a unique page title and description for search results.",
  no_h1: "Give each page one clear main heading.",
  no_schema: "Add LocalBusiness structured data so Google shows rich details.",
  no_open_graph: "Add social sharing tags so links look good when shared.",
  images_missing_alt: "Add descriptive alt text to images for accessibility and SEO.",
  no_click_to_call: "Make the phone number a tap-to-call link so mobile visitors can ring with one tap.",
  no_local_schema: "Add LocalBusiness structured data (name, address, hours) so Google can show the business details.",
  dated_build: "Rebuild the outdated parts with modern, responsive markup.",
  low_seo_score: "Fix the search issues Google's own check flagged (titles, link text, crawlable links).",
  low_accessibility: "Fix contrast, labels and other accessibility issues so every visitor can read and use the site.",
  no_sitemap: "Add a sitemap so Google can find every page.",
  mixed_content: "Load every image, script and stylesheet over https so browsers don't block or flag them.",
  no_https_redirect: "Redirect the plain http address to the secure https site.",
  no_email_auth: "Add SPF (and DMARC) records for the business email domain so messages reach inboxes.",
};

const CATEGORY_OF: Partial<Record<FindingCode, AuditCategory>> = {
  no_viewport: "mobile", mobile_overflow: "mobile", not_mobile_friendly: "mobile", small_text_mobile: "mobile",
  slow_mobile: "speed", meh_mobile: "speed", slow_lcp: "speed", layout_shift: "speed",
  stale_content: "content", old_copyright: "content", past_events: "content", thin_homepage: "content", missing_niche_page: "content",
  no_contact_path: "cro", no_cta: "cro", no_phone_visible: "cro", no_social_proof: "cro", no_nav: "cro", no_footer: "cro",
  broken_links: "technical", no_https: "technical", no_title_or_meta: "technical", no_h1: "technical", no_schema: "technical",
  no_open_graph: "technical", images_missing_alt: "technical",
  no_click_to_call: "cro", no_local_schema: "technical", dated_build: "content",
  low_seo_score: "technical", low_accessibility: "technical", no_sitemap: "technical", mixed_content: "technical",
  no_https_redirect: "technical", no_email_auth: "technical",
};

function rule(code: keyof typeof D, evidence: string): Finding {
  const points = D[code];
  return { code, category: CATEGORY_OF[code]!, severity: severityFor(points), points, evidence, recommendation: RECOMMEND[code] ?? "", source: "rule" };
}
/** A finding already reflected in a measured score (e.g. PageSpeed), so it deducts nothing itself. */
function note(code: FindingCode, category: AuditCategory, severity: Finding["severity"], evidence: string): Finding {
  return { code, category, severity, points: 0, evidence, recommendation: RECOMMEND[code] ?? "", source: "rule" };
}
function monthsBetween(iso: string, now: Date): number {
  const d = new Date(iso);
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}
const secs = (ms: number) => (ms / 1000).toFixed(1);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const blend = (rule: number, ai: number | undefined, w: number) => (ai === undefined ? rule : rule * (1 - w) + ai * w);

export function score(input: ScoreInput): ScoreResult {
  const { siteStatus, crawl, pagespeed: ps, now, mobile = null, review = null, business, mailDns } = input;
  const niche: NicheKey = review && review.niche in NICHES ? review.niche : guessNiche(business?.category ?? null);

  if (siteStatus === "no_website" || siteStatus === "parked" || siteStatus === "unreachable") {
    const map = {
      no_website: ["no_website", "No website listed on their Google Business profile"],
      parked: ["site_parked", "Their web address shows a placeholder or for-sale page"],
      unreachable: ["site_unreachable", "Their website didn't load when we tried it, even in a real browser"],
    } as const;
    const [code, evidence] = map[siteStatus];
    const finding: Finding = { code, category: "site", severity: "critical", points: 100, evidence,
      recommendation: "Build a simple, mobile-friendly website so customers can find and contact them.", source: "rule" };
    return { score: SITE_STATUS_SCORE[siteStatus], health: 0, categoryScores: {}, niche, findings: [finding], offer: "new_site", lowPriority: false };
  }

  const out: Finding[] = [];
  const cats: CategoryScores = {};
  // Crawl/PageSpeed facts may come from a step output cached by an older deploy (Workflows replays finished steps), so every
  // fact added later is read defensively: a missing value means "unknown" and never produces a finding.
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // We only read static HTML when no browser render was usable, so a JS-built page can hide anything: absence claims are suppressed for it.
  const js = crawl?.isLikelyJsRendered === true;
  // Homepage images, presence-based: the images really are in the HTML, so JS rendering doesn't undo it. Needs a few images,
  // so one undescribed logo is never "100% of images".
  const imgs = num(crawl?.imageCount), noAlt = num(crawl?.imagesMissingAlt);
  const missingAlt = imgs !== null && noAlt !== null && imgs >= T.missingAltMinImages && noAlt / imgs >= T.missingAltShare;
  const seoScore = num(ps?.seoScore), a11yScore = num(ps?.accessibilityScore);
  const deduct = (c: AuditCategory) => out.filter((f) => f.category === c && f.source === "rule").reduce((s, f) => s + f.points, 0);

  // Speed: PageSpeed is a measurement of load time only, so it is capped at 10% of Health.
  if (ps) {
    if (ps.performanceScore < T.slowMobileBelow)
      out.push(note("slow_mobile", "speed", "important", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    else if (ps.performanceScore < T.mehMobileBelow)
      out.push(note("meh_mobile", "speed", "nice", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    if (ps.lcpMs > T.slowLcpMs) out.push(rule("slow_lcp", `Main content takes about ${secs(ps.lcpMs)} seconds to appear on a phone`));
    if (ps.cls > T.layoutShiftCls) out.push(rule("layout_shift", "The page jumps around while it loads"));
    cats.speed = clamp(ps.performanceScore - deduct("speed"));

    // Lighthouse SEO / accessibility: listed under technical. The scorer owns all prospect-facing wording (labels.ts).
    if (seoScore !== null && seoScore < T.seoLowBelow) {
      // Drop ids that would repeat another claim or describe something that isn't the business's site:
      // image-alt (accessibility's), title/summary (the crawler's no_title_or_meta), is-crawlable on a bot-challenge page.
      const drop = new Set(["image-alt"]);
      if (siteStatus === "blocked") drop.add("is-crawlable");
      if (crawl && (!crawl.hasTitle || !crawl.hasMetaDescription)) { drop.add("document-title"); drop.add("meta-description"); }
      const issues = labelsFor((ps.seoIssueIds ?? []).filter((id) => !drop.has(id)), 3);
      out.push(rule("low_seo_score", issues.length
        ? `Google's own check flagged things that can hold the site back in search: ${issues.join(", ")}`
        : `Google's own check scored the homepage's search-friendliness at ${seoScore}/100`));
    }
    if (a11yScore !== null && a11yScore < T.a11yLowBelow) {
      // images_missing_alt already says it, so image-alt is not repeated.
      const issues = labelsFor((ps.accessibilityIssueIds ?? []).filter((id) => !(missingAlt && id === "image-alt")), 2);
      out.push(rule("low_accessibility", issues.length
        ? `Parts of the site are hard to read or use for some visitors (${issues.join(", ")})`
        : "Parts of the site are hard to read or use for some visitors"));
    }
  }

  // Mobile: prefer a real 390px render; fall back to the viewport tag and Lighthouse's checks.
  if (crawl || mobile || ps) {
    if (crawl && !crawl.hasViewport) out.push(rule("no_viewport", "The site isn't built to resize for phones (no mobile viewport)"));
    if (mobile?.overflowX) out.push(rule("mobile_overflow", "On a phone the page is wider than the screen, so visitors have to scroll sideways"));
    if (mobile && mobile.smallTextPct > T.smallTextPct)
      out.push(rule("small_text_mobile", `About ${Math.round(mobile.smallTextPct * 100)}% of the text is too small to read comfortably on a phone`));
    if (!mobile && ps && !ps.mobileFriendly && !(crawl && !crawl.hasViewport))
      out.push(rule("not_mobile_friendly", "Text and buttons are hard to read and tap on a phone"));
    cats.mobile = clamp(blend(100 - deduct("mobile"), review?.scores.mobile, AI_BLEND.mobile));
  }

  if (crawl) {
    // Content
    if (crawl.latestContentDate && monthsBetween(crawl.latestContentDate, now) > T.staleContentMonths)
      out.push(rule("stale_content", `The newest post or update is from ${crawl.latestContentDate.slice(0, 7)}`));
    if (crawl.copyrightYear !== null && crawl.copyrightYear <= now.getUTCFullYear() - T.oldCopyrightYearsBack)
      out.push(rule("old_copyright", `The footer still says © ${crawl.copyrightYear}`));
    if (crawl.pastEventDates.length > 0)
      out.push(rule("past_events", `Lists events that already happened (e.g. ${crawl.pastEventDates[0]})`));
    const markers = Array.isArray(crawl.datedBuildMarkers) ? crawl.datedBuildMarkers : [];
    if (markers.length >= 1)
      out.push(rule("dated_build", `The site is built with outdated techniques (${markers.slice(0, 2).join(", ")})`));
    if (crawl.homeWordCount < T.thinHomepageWords && !js)
      out.push(rule("thin_homepage", `The homepage has only about ${crawl.homeWordCount} words, so it says little about the business`));
    for (const p of NICHES[niche].pages) {
      if (!crawl.pageKinds.includes(p.kind)) out.push(rule("missing_niche_page", `No ${p.kind} page. ${p.why}`));
    }
    cats.content = clamp(blend(100 - deduct("content"), review?.scores.content, AI_BLEND.content));

    // Conversion: is there an obvious way to become a customer?
    const contactPath = crawl.hasContactForm || crawl.emailCount > 0 || crawl.hasBooking;
    if (!contactPath) out.push(rule("no_contact_path", "There's no contact form, booking link, or email address anywhere on the site"));
    if (!crawl.hasCta) out.push(rule("no_cta", "No clear button telling visitors what to do next (call, book, get a quote)"));
    if (!crawl.phoneVisible) out.push(rule("no_phone_visible", "No phone number on the homepage"));
    else if (crawl.hasPhone === true && crawl.hasTelLink === false && !js)
      out.push(rule("no_click_to_call", "Their phone number isn't set up as a tap-to-call link, so on many phones visitors have to copy and paste it"));
    if (!crawl.hasSocialProof) out.push(rule("no_social_proof", "No reviews or testimonials on the site"));
    if (!crawl.hasNav) out.push(rule("no_nav", "No navigation menu was found, so visitors can't easily reach other pages"));
    if (!crawl.hasFooter) out.push(rule("no_footer", "No footer with contact details and links"));
    cats.cro = clamp(blend(100 - deduct("cro"), review?.scores.cro, AI_BLEND.cro));

    // Technical
    if (!crawl.https) out.push(rule("no_https", "The site isn't secure (no HTTPS), so browsers show a warning"));
    if (!crawl.hasTitle || !crawl.hasMetaDescription)
      out.push(rule("no_title_or_meta", "The homepage is missing the title or summary Google shows in search results"));
    if (crawl.brokenLinkCount >= T.brokenLinksMin)
      out.push(rule("broken_links", `${crawl.brokenLinkCount} links on the site lead to missing pages`));
    if (!crawl.hasH1 && !js) out.push(rule("no_h1", "The homepage has no main heading"));
    // No structured data at all, or some (e.g. a WebSite block) that never describes the business: never both. Business microdata,
    // RDFa or array-typed JSON-LD (hasLocalBusinessSchema) counts as structured data even when no string @type was read.
    if (crawl.schemaTypes.length === 0 && crawl.hasLocalBusinessSchema !== true && !js) out.push(rule("no_schema", "No structured business data for Google (schema.org)"));
    else if (crawl.schemaTypes.length > 0 && crawl.hasLocalBusinessSchema === false && !js)
      out.push(rule("no_local_schema", "The site doesn't include business details (name, address, hours) in a form Google can read"));
    if (!crawl.hasOpenGraph) out.push(rule("no_open_graph", "Links shared on social media won't show a preview image or title"));
    if (missingAlt)
      out.push(rule("images_missing_alt", `${noAlt} of ${imgs} images have no description, so Google and screen readers can't tell what they show`));
    if (crawl.hasSitemap === false)
      out.push(rule("no_sitemap", "The site has no sitemap file, which helps Google find all of a site's pages"));
    if ((num(crawl.mixedContentCount) ?? 0) >= 1)
      out.push(rule("mixed_content", "The page loads some content over an insecure connection, which browsers may block or flag"));
    if (crawl.httpRedirectsToHttps === false)
      out.push(rule("no_https_redirect", "Visiting the site without the secure 'https' version doesn't send people to the secure page"));
  }

  // Only when they demonstrably have mail (MX) and demonstrably lack SPF; DMARC is deliberately never claimed (too common to be absent).
  if (mailDns?.hasMx === true && mailDns.hasSpf === false)
    out.push(rule("no_email_auth", "Their business email isn't set up with the sender-verification records that help messages reach inboxes, so some may end up in spam"));
  if (crawl) cats.technical = clamp(100 - deduct("technical"));

  // Design comes only from the AI review of real screenshots: rules can't judge looks.
  if (review) {
    cats.design = clamp(review.scores.design);
    if (cats.content === undefined) cats.content = clamp(review.scores.content);
    if (cats.cro === undefined) cats.cro = clamp(review.scores.cro);
    review.findings.forEach((f, i) => out.push({
      code: `ai_${f.category}_${i}`, category: f.category, severity: f.severity, points: 0,
      evidence: `${f.title}. ${f.evidence}`.trim(), recommendation: f.recommendation, source: "ai",
    }));
  }

  const entries = Object.entries(cats) as [AuditCategory, number][];
  const totalW = entries.reduce((s, [c]) => s + CATEGORY_WEIGHTS[c], 0);
  const health = totalW ? clamp(entries.reduce((s, [c, v]) => s + v * CATEGORY_WEIGHTS[c], 0) / totalW) : null;

  // Opportunity: how much better the site could be, plus signs the business can pay for it.
  let opportunity = 0;
  if (health !== null) {
    const critical = out.filter((f) => f.severity === "critical").length;
    const rc = business?.reviewCount ?? 0;
    const established = (rc >= 25 ? 10 : rc >= 10 ? 5 : 0) + ((business?.rating ?? 0) >= 4.3 ? 5 : 0);
    opportunity = clamp((100 - health) * 0.85 + Math.min(15, critical * 5) + established);
  }

  const rank: Record<Finding["severity"], number> = { critical: 0, important: 1, nice: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.points - a.points);
  // A paid auto-draft also needs at least one finding that matters: a pile of small ones on a healthy site isn't a reason to pitch.
  const lowPriority = opportunity < T.lowPriorityBelow || !out.some((f) => f.severity !== "nice");
  return { score: opportunity, health, categoryScores: cats, niche, findings: out, offer: pickOffer(cats, health), lowPriority };
}

function pickOffer(c: CategoryScores, health: number | null): Offer {
  if (health === null) return "care_plan";
  if (health < 45 || ((c.design ?? 100) < 50 && (c.mobile ?? 100) < 60)) return "new_site";
  const weakest = (Object.entries(c) as [AuditCategory, number][]).sort((a, b) => a[1] - b[1])[0];
  if (!weakest || weakest[1] >= 80) return "care_plan";
  const byCat: Record<AuditCategory, Offer> = {
    design: "new_site", mobile: "new_site", speed: "performance", content: "care_plan", cro: "conversion", technical: "seo_basics",
  };
  return byCat[weakest[0]];
}
