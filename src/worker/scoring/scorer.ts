import type { AiReview, AuditCategory, CategoryScores, Finding, FindingCode, Offer, PageKind, SiteStatus } from "../types";
import { AI_BLEND, CATEGORY_WEIGHTS, DEDUCTIONS as D, SITE_STATUS_SCORE, THRESHOLDS as T, severityFor } from "./config";
import { NICHES, guessNiche, type NicheKey } from "../audit/rubrics";

export interface CrawlFacts {
  https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean;
  hasContactForm: boolean; emailCount: number; copyrightYear: number | null;
  latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number;
  hasNav: boolean; navItemCount: number; hasFooter: boolean; hasH1: boolean; hasCta: boolean;
  hasSocialProof: boolean; hasBooking: boolean; hasOpenGraph: boolean; schemaTypes: string[];
  homeWordCount: number; imagesMissingAltPct: number; phoneVisible: boolean;
  pageKinds: PageKind[]; rendered: boolean;
}
export interface PageSpeedFacts { performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean; }
/** Measured in a real 390px-wide browser: the ground truth for "works on a phone". */
export interface MobileFacts { overflowX: boolean; smallTextPct: number; }
export interface BusinessSignals { category: string | null; rating: number | null; reviewCount: number | null; }

export interface ScoreInput {
  siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date;
  mobile?: MobileFacts | null; review?: AiReview | null; business?: BusinessSignals;
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
};

const CATEGORY_OF: Partial<Record<FindingCode, AuditCategory>> = {
  no_viewport: "mobile", mobile_overflow: "mobile", not_mobile_friendly: "mobile", small_text_mobile: "mobile",
  slow_mobile: "speed", meh_mobile: "speed", slow_lcp: "speed", layout_shift: "speed",
  stale_content: "content", old_copyright: "content", past_events: "content", thin_homepage: "content", missing_niche_page: "content",
  no_contact_path: "cro", no_cta: "cro", no_phone_visible: "cro", no_social_proof: "cro", no_nav: "cro", no_footer: "cro",
  broken_links: "technical", no_https: "technical", no_title_or_meta: "technical", no_h1: "technical", no_schema: "technical",
  no_open_graph: "technical", images_missing_alt: "technical",
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
  const { siteStatus, crawl, pagespeed: ps, now, mobile = null, review = null, business } = input;
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
    if (crawl.homeWordCount < T.thinHomepageWords)
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
    if (!crawl.hasH1) out.push(rule("no_h1", "The homepage has no main heading"));
    if (crawl.schemaTypes.length === 0) out.push(rule("no_schema", "No structured business data for Google (schema.org)"));
    if (!crawl.hasOpenGraph) out.push(rule("no_open_graph", "Links shared on social media won't show a preview image or title"));
    if (crawl.imagesMissingAltPct > T.missingAltPct)
      out.push(rule("images_missing_alt", `${Math.round(crawl.imagesMissingAltPct * 100)}% of images have no description (alt text)`));
    cats.technical = clamp(100 - deduct("technical"));
  }

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
  return { score: opportunity, health, categoryScores: cats, niche, findings: out, offer: pickOffer(cats, health), lowPriority: opportunity < T.lowPriorityBelow };
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
