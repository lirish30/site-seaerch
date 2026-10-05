import { describe, it, expect } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";
import { AUDIT_LABELS } from "../src/worker/scoring/labels";
import type { AiReview } from "../src/worker/types";

const now = new Date("2026-10-02T00:00:00Z");
// Neutral values for the page and site-level facts: none of them fires a finding.
const neutralFacts = {
  platform: "other" as const, h1Count: 1, wordCount: 600, imageCount: 0, imagesMissingAlt: 0, hasPhone: true, hasTelLink: true,
  hasLocalBusinessSchema: true, mixedContentCount: 0, datedBuildMarkers: [] as string[], isLikelyJsRendered: false,
  hasRobotsTxt: true, hasSitemap: true, httpRedirectsToHttps: true,
};
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0,
  hasNav: true, navItemCount: 6, hasFooter: true, hasH1: true, hasCta: true, hasSocialProof: true, hasBooking: false,
  hasOpenGraph: true, schemaTypes: ["LocalBusiness"], homeWordCount: 600, imagesMissingAltPct: 0, phoneVisible: true,
  pageKinds: ["about", "contact", "services", "portfolio", "team", "menu", "locations", "booking", "pricing", "shop", "events"], rendered: true,
  ...neutralFacts,
};
const noLh = { seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] };
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true, ...noLh };
const review = (o: Partial<AiReview["scores"]> = {}, niche = "general"): AiReview => ({
  niche, value_proposition: "x", scores: { design: 88, content: 80, cro: 80, mobile: 90, ...o },
  summaries: { design: "", content: "", cro: "", mobile: "" }, strengths: [], niche_checklist: [], findings: [],
});
const codes = (r: ReturnType<typeof score>) => r.findings.map((f) => f.code).sort();

describe("score: site status", () => {
  it("no website → health 0, opportunity 100, new_site", () => {
    const r = score({ siteStatus: "no_website", crawl: null, pagespeed: null, now });
    expect([r.health, r.score, r.offer]).toEqual([0, 100, "new_site"]);
    expect(codes(r)).toEqual(["no_website"]);
  });

  it("parked and unreachable → opportunity 90, new_site", () => {
    expect(score({ siteStatus: "parked", crawl: null, pagespeed: null, now }).score).toBe(90);
    expect(score({ siteStatus: "unreachable", crawl: null, pagespeed: null, now }).offer).toBe("new_site");
  });

  it("blocked with nothing measured → health unknown, opportunity 0, low priority", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: null, now });
    expect(r.health).toBeNull();
    expect(r.score).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.lowPriority).toBe(true);
  });

  it("blocked with PageSpeed → speed and mobile from PageSpeed only", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.02, mobileFriendly: false, ...noLh }, now });
    expect(codes(r)).toEqual(["not_mobile_friendly", "slow_lcp", "slow_mobile"]);
    expect(Object.keys(r.categoryScores).sort()).toEqual(["mobile", "speed"]);
    expect(r.findings.every((f) => f.category !== "site")).toBe(true);
  });
});

describe("score: two scores", () => {
  it("healthy site → high health, low opportunity", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: goodPs, now, review: review() });
    expect(r.health).toBeGreaterThanOrEqual(85);
    expect(r.lowPriority).toBe(true);
    expect(r.findings.filter((f) => f.source === "rule")).toEqual([]);
  });

  it("beautiful but slow site keeps a good health score (speed is only 10%)", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, pageKinds: ["about", "contact"] },
      pagespeed: { performanceScore: 28, lcpMs: 7000, cls: 0.05, mobileFriendly: true, ...noLh }, now,
      mobile: { overflowX: false, smallTextPct: 0.05 }, review: review({ design: 90, mobile: 92 }) });
    expect(r.health).toBeGreaterThanOrEqual(70);
    expect(r.categoryScores.design).toBe(90);
    expect(r.categoryScores.speed).toBeLessThan(30);
    expect(codes(r)).toContain("slow_mobile");
  });

  it("dated site without nav or footer scores poorly and is pitched a new site", () => {
    const r = score({ siteStatus: "ok", now,
      crawl: { ...goodCrawl, hasNav: false, navItemCount: 0, hasFooter: false, hasCta: false, hasSocialProof: false,
        copyrightYear: 2016, latestContentDate: "2017-03-01", hasViewport: false, homeWordCount: 80 },
      pagespeed: { performanceScore: 45, lcpMs: 5000, cls: 0.1, mobileFriendly: false, ...noLh },
      mobile: { overflowX: true, smallTextPct: 0.5 }, review: review({ design: 30, content: 35, cro: 30, mobile: 20 }) });
    expect(codes(r)).toEqual(expect.arrayContaining(["no_nav", "no_footer", "no_cta", "no_viewport", "mobile_overflow", "old_copyright", "stale_content", "thin_homepage"]));
    expect(r.health).toBeLessThan(45);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.offer).toBe("new_site");
  });

  it("opportunity rises for established businesses (reviews, rating)", () => {
    const base = { siteStatus: "ok" as const, crawl: { ...goodCrawl, hasCta: false, hasSocialProof: false }, pagespeed: goodPs, now, review: review({ cro: 50 }) };
    const small = score({ ...base, business: { category: null, rating: 3.9, reviewCount: 2 } });
    const big = score({ ...base, business: { category: null, rating: 4.8, reviewCount: 120 } });
    expect(big.score - small.score).toBe(15);
  });
});

describe("score: niche checks", () => {
  it("restaurant without a menu page gets a missing-page finding", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, pageKinds: ["about", "contact"] }, pagespeed: goodPs, now,
      business: { category: "Italian restaurant", rating: null, reviewCount: null } });
    expect(r.niche).toBe("restaurant");
    const missing = r.findings.filter((f) => f.code === "missing_niche_page").map((f) => f.evidence);
    expect(missing.some((e) => e.startsWith("No menu page"))).toBe(true);
  });

  it("B2B firm without a services page is flagged; the AI's niche wins over the category guess", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, pageKinds: ["contact", "about", "team"] }, pagespeed: goodPs, now,
      business: { category: "Corporate office", rating: null, reviewCount: null }, review: review({}, "professional") });
    expect(r.niche).toBe("professional");
    expect(r.findings.some((f) => f.code === "missing_niche_page" && f.evidence.startsWith("No services page"))).toBe(true);
    expect(r.findings.some((f) => f.code === "missing_niche_page" && f.evidence.startsWith("No portfolio page"))).toBe(true);
  });
});

describe("score: rules", () => {
  it("contact path counts forms, emails and booking widgets anywhere on the site", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 1 }, pagespeed: goodPs, now }))).not.toContain("no_contact_path");
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 0, hasBooking: true }, pagespeed: goodPs, now }))).not.toContain("no_contact_path");
    const none = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 0 }, pagespeed: goodPs, now });
    expect(none.findings.find((f) => f.code === "no_contact_path")!.severity).toBe("critical");
  });

  it("a real mobile render overrides Lighthouse's mobile-friendly flag", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, mobileFriendly: false, ...noLh }, now, mobile: { overflowX: false, smallTextPct: 0 } });
    expect(codes(r)).not.toContain("not_mobile_friendly");
    expect(r.categoryScores.mobile).toBe(100);
  });

  it("slow_mobile and meh_mobile are mutually exclusive and only informational", () => {
    const slow = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30 }, now });
    expect(codes(slow)).toEqual(["slow_mobile"]);
    expect(slow.findings[0].points).toBe(0);
    expect(slow.categoryScores.speed).toBe(30);
    expect(codes(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 60 }, now }))).toEqual(["meh_mobile"]);
  });

  it("copyright exactly current-2 counts, current-1 does not", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2024 }, pagespeed: goodPs, now }))).toContain("old_copyright");
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2025 }, pagespeed: goodPs, now }))).not.toContain("old_copyright");
  });

  it("weakest category picks the offer", () => {
    expect(score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, hasTitle: false, schemaTypes: [], hasLocalBusinessSchema: false, hasH1: false }, pagespeed: goodPs, now }).offer).toBe("seo_basics");
    expect(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 35, lcpMs: 6000, cls: 0.4, mobileFriendly: true, ...noLh }, now }).offer).toBe("performance");
    expect(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasCta: false, hasSocialProof: false, phoneVisible: false }, pagespeed: goodPs, now }).offer).toBe("conversion");
  });

  it("AI findings are listed with their own severity but deduct nothing", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: goodPs, now, review: { ...review(), findings: [
      { category: "design", severity: "important", title: "Hero image is blurry", evidence: "The top photo is pixelated", recommendation: "Use a sharp photo" },
    ] } });
    const f = r.findings.find((x) => x.source === "ai")!;
    expect(f).toMatchObject({ category: "design", severity: "important", points: 0, evidence: "Hero image is blurry. The top photo is pixelated" });
  });

  it("findings are sorted critical first and carry recommendations", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, schemaTypes: [], hasLocalBusinessSchema: false }, pagespeed: goodPs, now });
    expect(r.findings.map((f) => f.severity)).toEqual(["critical", "nice"]);
    expect(r.findings.every((f) => f.recommendation.length > 0)).toBe(true);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
});

// Detections that origin/main added (Lighthouse SEO/accessibility, crawl-level facts, mail DNS), ported onto the
// category/Health model: each is a rule finding in a category with a deduction instead of a group weight.
describe("score: low priority needs a finding that matters", () => {
  it("a weak-looking site with only small findings stays low priority (no paid draft); one important finding makes it a pitch", () => {
    const lowOnly = { ...goodCrawl, schemaTypes: ["WebSite"], hasLocalBusinessSchema: false, httpRedirectsToHttps: false, hasSitemap: false };
    const weak = review({ design: 30, content: 40, cro: 40, mobile: 40 });
    const r = score({ siteStatus: "ok", crawl: lowOnly, pagespeed: goodPs, now, review: weak });
    expect(r.score).toBeGreaterThanOrEqual(25);
    expect(r.findings.every((f) => f.severity === "nice")).toBe(true);
    expect(r.lowPriority).toBe(true);
    const withImportant = score({ siteStatus: "ok", crawl: lowOnly, pagespeed: { ...goodPs, seoScore: 40 }, now, review: weak });
    expect(withImportant.findings.some((f) => f.code === "low_seo_score" && f.severity === "important")).toBe(true);
    expect(withImportant.lowPriority).toBe(false);
  });
});

describe("score: lighthouse seo + accessibility", () => {
  const run = (ps: Partial<PageSpeedFacts> | null, crawl: CrawlFacts | null = goodCrawl) =>
    score({ siteStatus: "ok", crawl, pagespeed: ps ? { ...goodPs, ...ps } : null, now });
  const find = (r: ReturnType<typeof score>, code: string) => r.findings.find((f) => f.code === code);

  it("low_seo_score fires below 70, not at 70", () => {
    expect(codes(run({ seoScore: 69 }))).toEqual(["low_seo_score"]);
    expect(codes(run({ seoScore: 70 }))).toEqual([]);
    expect(find(run({ seoScore: 69 }), "low_seo_score")).toMatchObject({ category: "technical", points: 15, severity: "important", source: "rule" });
  });

  it("low_accessibility fires below 70, not at 70", () => {
    expect(codes(run({ accessibilityScore: 69 }))).toEqual(["low_accessibility"]);
    expect(codes(run({ accessibilityScore: 70 }))).toEqual([]);
    expect(find(run({ accessibilityScore: 0 }), "low_accessibility")).toMatchObject({ category: "technical", points: 10, severity: "nice" });
  });

  it("no findings when pagespeed is missing or the scores are null", () => {
    expect(run(null).findings).toEqual([]);
    expect(run({ seoScore: null, accessibilityScore: null, seoIssueIds: ["document-title"], accessibilityIssueIds: ["html-has-lang"] }).findings).toEqual([]);
  });

  it("seo evidence: first three labelled issues, or the score when there are none", () => {
    const ev = (ps: Partial<PageSpeedFacts>) => find(run({ seoScore: 40, ...ps }), "low_seo_score")!.evidence;
    expect(ev({ seoIssueIds: ["link-text", "crawlable-anchors", "hreflang", "is-crawlable"] }))
      .toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here', links Google can't follow, broken language settings");
    expect(ev({ seoIssueIds: ["link-text"] })).toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here'");
    expect(ev({})).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
    // unmapped ids are ignored, never shown, and don't use up a truncation slot
    expect(ev({ seoIssueIds: ["tap-targets", "robots-txt", "canonical"] }))
      .toBe("Google's own check flagged things that can hold the site back in search: a page-address setting that points to the wrong place");
    expect(ev({ seoIssueIds: ["tap-targets", "robots-txt"] })).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
  });

  it("accessibility evidence: first two labelled issues, or generic when there are none", () => {
    const ev = (ids: string[]) => find(run({ accessibilityScore: 50, accessibilityIssueIds: ids }), "low_accessibility")!.evidence;
    expect(ev(["color-contrast", "label", "html-has-lang"])).toBe("Parts of the site are hard to read or use for some visitors (text that's hard to read against its background, form fields without labels)");
    expect(ev(["label"])).toBe("Parts of the site are hard to read or use for some visitors (form fields without labels)");
    expect(ev(["aria-allowed-attr"])).toBe("Parts of the site are hard to read or use for some visitors");
    expect(ev([])).toBe("Parts of the site are hard to read or use for some visitors");
  });

  it("every label in the table is plain English", () => {
    const labels = Object.values(AUDIT_LABELS);
    expect(labels.length).toBeGreaterThan(5);
    for (const l of labels) expect(l).not.toMatch(/robots|canonical|\balt\b|meta|hreflang|aria|lang attr|lighthouse|ADA|compliant/i);
    const r = run({ seoScore: 10, accessibilityScore: 10 });
    for (const f of r.findings) expect(f.evidence).not.toMatch(/ADA\b|complian|lighthouse|lawsuit|legal/i);
  });

  it("image-alt is claimed under accessibility only, never under seo", () => {
    const r = run({ seoScore: 40, accessibilityScore: 40, seoIssueIds: ["image-alt", "link-text"], accessibilityIssueIds: ["image-alt"] });
    expect(find(r, "low_seo_score")!.evidence).not.toContain("images");
    expect(find(r, "low_seo_score")!.evidence).toContain("links that just say");
    expect(find(r, "low_accessibility")!.evidence).toContain("images without text descriptions");
    expect(find(run({ seoScore: 40, seoIssueIds: ["image-alt"] }), "low_seo_score")!.evidence).toContain("40/100");
  });

  it("drops title/summary ids from seo evidence when the crawler already reported them", () => {
    const ids = ["document-title", "meta-description", "link-text"];
    const crawled = run({ seoScore: 40, seoIssueIds: ids }, { ...goodCrawl, hasTitle: false });
    expect(codes(crawled)).toEqual(["low_seo_score", "no_title_or_meta"]);
    expect(find(crawled, "low_seo_score")!.evidence).toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here'");
    const only = run({ seoScore: 40, seoIssueIds: ["meta-description"] }, { ...goodCrawl, hasMetaDescription: false });
    expect(find(only, "low_seo_score")!.evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
    expect(find(run({ seoScore: 40, seoIssueIds: ids }), "low_seo_score")!.evidence).toContain("no page title, no search-results summary");
    expect(find(run({ seoScore: 40, seoIssueIds: ids }, null), "low_seo_score")!.evidence).toContain("no page title");
  });

  it("blocked site: listed from PageSpeed only, and is-crawlable is not claimed", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable", "link-text"] }, now });
    expect(codes(r)).toEqual(["low_seo_score"]);
    expect(r.findings[0].evidence).not.toContain("blocked from Google");
    expect(r.findings[0].evidence).toContain("links that just say");
    const only = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable"] }, now });
    expect(only.findings[0].evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
    expect(find(run({ seoScore: 40, seoIssueIds: ["is-crawlable"] }), "low_seo_score")!.evidence).toContain("blocked from Google");
  });

  it("seo findings weaken the technical category and can make it the seo_basics pitch", () => {
    const r = run({ seoScore: 30, accessibilityScore: 30 });
    expect(r.categoryScores.technical).toBe(75);
    expect(r.offer).toBe("seo_basics");
  });
});

describe("score: crawl-level findings", () => {
  const run = (c: Partial<CrawlFacts>, ps: Partial<PageSpeedFacts> = {}) =>
    score({ siteStatus: "ok", crawl: { ...goodCrawl, ...c }, pagespeed: { ...goodPs, ...ps }, now });
  const find = (r: ReturnType<typeof score>, code: string) => r.findings.find((f) => f.code === code);
  const BANNED = /lighthouse|schema|json|sitemap\.xml|robots|\bH1\b|alt text|viewport|meta description|jquery/i;

  it("no_click_to_call: phone shown but no tap-to-call link", () => {
    expect(find(run({ hasTelLink: false }), "no_click_to_call")).toMatchObject({ category: "cro", points: 8, severity: "nice",
      evidence: "Their phone number isn't set up as a tap-to-call link, so on many phones visitors have to copy and paste it" });
    expect(codes(run({ hasPhone: true, hasTelLink: true }))).toEqual([]);
    expect(codes(run({ hasPhone: false, hasTelLink: false }))).toEqual([]);
    // no phone on the homepage at all is the bigger claim, never both
    expect(codes(run({ phoneVisible: false, hasTelLink: false }))).toEqual(["no_phone_visible"]);
  });

  it("no_local_schema: structured data that never describes the business; never alongside no_schema", () => {
    expect(find(run({ schemaTypes: ["WebSite"], hasLocalBusinessSchema: false }), "no_local_schema")).toMatchObject({ category: "technical", points: 5,
      severity: "nice", evidence: "The site doesn't include business details (name, address, hours) in a form Google can read" });
    expect(codes(run({ schemaTypes: [], hasLocalBusinessSchema: false }))).toEqual(["no_schema"]);
    expect(codes(run({ schemaTypes: ["WebSite"], hasLocalBusinessSchema: true }))).toEqual([]);
  });

  it("images_missing_alt: needs 4+ homepage images and at least half missing", () => {
    expect(codes(run({ imageCount: 3, imagesMissingAlt: 3 }))).toEqual([]);
    expect(codes(run({ imageCount: 4, imagesMissingAlt: 2 }))).toEqual(["images_missing_alt"]);
    expect(codes(run({ imageCount: 4, imagesMissingAlt: 1 }))).toEqual([]);
    expect(codes(run({ imageCount: 100, imagesMissingAlt: 49 }))).toEqual([]);
    expect(codes(run({ imageCount: 100, imagesMissingAlt: 50 }))).toEqual(["images_missing_alt"]);
    expect(codes(run({ imageCount: 1, imagesMissingAlt: 1, imagesMissingAltPct: 1 }))).toEqual([]); // one logo is never "100% of images"
    expect(find(run({ imageCount: 10, imagesMissingAlt: 7 }), "images_missing_alt")).toMatchObject({ category: "technical", points: 10,
      evidence: "7 of 10 images have no description, so Google and screen readers can't tell what they show" });
  });

  it("images_missing_alt removes image-alt from the accessibility evidence (no double claim)", () => {
    const a11y = { accessibilityScore: 40, accessibilityIssueIds: ["image-alt", "color-contrast", "label"] };
    expect(find(run({}, a11y), "low_accessibility")!.evidence)
      .toBe("Parts of the site are hard to read or use for some visitors (images without text descriptions, text that's hard to read against its background)");
    const both = run({ imageCount: 4, imagesMissingAlt: 4 }, a11y);
    expect(find(both, "low_accessibility")!.evidence)
      .toBe("Parts of the site are hard to read or use for some visitors (text that's hard to read against its background, form fields without labels)");
    const only = run({ imageCount: 4, imagesMissingAlt: 4 }, { accessibilityScore: 40, accessibilityIssueIds: ["image-alt"] });
    expect(find(only, "low_accessibility")!.evidence).toBe("Parts of the site are hard to read or use for some visitors");
  });

  it("no_schema is not claimed when business microdata / RDFa / array-typed JSON-LD was found", () => {
    expect(codes(run({ schemaTypes: [], hasLocalBusinessSchema: true }))).toEqual([]);
    expect(codes(run({ schemaTypes: [], hasLocalBusinessSchema: false }))).toEqual(["no_schema"]);
  });

  it("crawl facts cached by the pre-merge deploy (no new fields) score without throwing or guessing", () => {
    const NEW = ["platform", "h1Count", "wordCount", "imageCount", "imagesMissingAlt", "hasPhone", "hasTelLink", "hasLocalBusinessSchema",
      "mixedContentCount", "datedBuildMarkers", "isLikelyJsRendered", "hasRobotsTxt", "hasSitemap", "httpRedirectsToHttps"];
    const old = (c: Partial<CrawlFacts>) => { const o: Record<string, unknown> = { ...goodCrawl, ...c }; for (const k of NEW) delete o[k]; return o as unknown as CrawlFacts; };
    const oldPs = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true } as unknown as PageSpeedFacts;
    const depends = ["dated_build", "no_local_schema", "no_click_to_call", "images_missing_alt", "no_sitemap", "mixed_content", "no_https_redirect", "low_seo_score", "low_accessibility"];
    for (const c of [old({}), old({ schemaTypes: ["WebSite"] }), old({ imagesMissingAltPct: 1 }), old({ phoneVisible: true })]) {
      const r = score({ siteStatus: "ok", crawl: c, pagespeed: oldPs, now });
      for (const f of r.findings) expect(depends, f.code).not.toContain(f.code);
    }
    expect(score({ siteStatus: "ok", crawl: old({}), pagespeed: oldPs, now }).findings).toEqual([]);
    // the facts it does have still count: no structured data at all is still claimed
    expect(codes(score({ siteStatus: "ok", crawl: old({ schemaTypes: [] }), pagespeed: oldPs, now }))).toEqual(["no_schema"]);
  });

  it("no_sitemap only when definitely absent (null = unknown)", () => {
    expect(find(run({ hasSitemap: false }), "no_sitemap")).toMatchObject({ category: "technical", points: 5,
      evidence: "The site has no sitemap file, which helps Google find all of a site's pages" });
    expect(codes(run({ hasSitemap: null }))).toEqual([]);
    expect(codes(run({ hasRobotsTxt: false }))).toEqual([]); // no finding for robots.txt
  });

  it("mixed_content", () => {
    expect(find(run({ mixedContentCount: 1 }), "mixed_content")).toMatchObject({ category: "technical", points: 10, severity: "nice",
      evidence: "The page loads some content over an insecure connection, which browsers may block or flag" });
    expect(codes(run({ mixedContentCount: 0 }))).toEqual([]);
  });

  it("no_https_redirect only when definitely false", () => {
    expect(find(run({ httpRedirectsToHttps: false }), "no_https_redirect")).toMatchObject({ category: "technical", points: 8,
      evidence: "Visiting the site without the secure 'https' version doesn't send people to the secure page" });
    expect(codes(run({ httpRedirectsToHttps: null }))).toEqual([]);
    expect(codes(run({ httpRedirectsToHttps: true }))).toEqual([]);
  });

  it("dated_build lists the first two markers", () => {
    expect(find(run({ datedBuildMarkers: ["frames"] }), "dated_build")).toMatchObject({ category: "content", points: 15, severity: "important",
      evidence: "The site is built with outdated techniques (frames)" });
    expect(find(run({ datedBuildMarkers: ["Flash", "frames", "x"] }), "dated_build")!.evidence)
      .toBe("The site is built with outdated techniques (Flash, frames)");
    expect(codes(run({ datedBuildMarkers: [] }))).toEqual([]);
  });

  it("isLikelyJsRendered suppresses absence-based findings only", () => {
    const absent = { hasTelLink: false, schemaTypes: [] as string[], hasLocalBusinessSchema: false, homeWordCount: 10, hasH1: false };
    expect(codes(run(absent))).toEqual(["no_click_to_call", "no_h1", "no_schema", "thin_homepage"]);
    expect(codes(run({ ...absent, isLikelyJsRendered: true }))).toEqual([]);
    expect(codes(run({ schemaTypes: ["WebSite"], hasLocalBusinessSchema: false, isLikelyJsRendered: true }))).toEqual([]);
    const present = { imageCount: 5, imagesMissingAlt: 5, hasSitemap: false, mixedContentCount: 2, httpRedirectsToHttps: false, datedBuildMarkers: ["frames"] };
    expect(codes(run({ ...present, isLikelyJsRendered: true }))).toEqual(["dated_build", "images_missing_alt", "mixed_content", "no_https_redirect", "no_sitemap"]);
  });

  it("no new crawl findings when the crawl is null (blocked)", () => {
    expect(score({ siteStatus: "blocked", crawl: null, pagespeed: goodPs, now }).findings).toEqual([]);
  });

  it("evidence of every new finding is free of jargon", () => {
    const r = run({ hasTelLink: false, schemaTypes: ["WebSite"], hasLocalBusinessSchema: false, imageCount: 8, imagesMissingAlt: 8, hasSitemap: false, mixedContentCount: 3, httpRedirectsToHttps: false,
      datedBuildMarkers: ["old-style font tags", "scrolling or blinking text", "frames", "Flash", "old-style centering tags", "an old, no-longer-updated code library", "table-based page layout"] });
    const newCodes = ["no_click_to_call", "no_local_schema", "images_missing_alt", "no_sitemap", "mixed_content", "no_https_redirect", "dated_build"];
    expect(codes(r)).toEqual([...newCodes].sort());
    for (const c of newCodes) expect(find(r, c)!.evidence, c).not.toMatch(BANNED);
    for (const m of ["old-style font tags", "scrolling or blinking text", "frames", "Flash", "old-style centering tags", "an old, no-longer-updated code library", "table-based page layout"]) {
      const ev = run({ datedBuildMarkers: [m] }).findings[0].evidence;
      expect(ev).not.toMatch(BANNED);
      expect(ev.match(/outdated/g)).toHaveLength(1);
    }
  });
});

describe("score: no_email_auth (mail DNS)", () => {
  const EV = "Their business email isn't set up with the sender-verification records that help messages reach inboxes, so some may end up in spam";
  const run = (mailDns: { hasMx: boolean | null; hasSpf: boolean | null } | null | undefined, siteStatus: "ok" | "blocked" | "unreachable" | "parked" | "no_website" = "ok") =>
    score({ siteStatus, crawl: siteStatus === "ok" ? goodCrawl : null, pagespeed: goodPs, now, ...(mailDns === undefined ? {} : { mailDns }) });
  const hit = (r: ReturnType<typeof score>) => r.findings.find((x) => x.code === "no_email_auth");

  it("fires only for MX present and SPF absent, with exact evidence, under technical", () => {
    expect(hit(run({ hasMx: true, hasSpf: false }))).toMatchObject({ code: "no_email_auth", category: "technical", points: 5, severity: "nice", evidence: EV });
  });
  it("counts against the technical category", () => {
    expect(run({ hasMx: true, hasSpf: false }).categoryScores.technical).toBe(95);
  });
  it("does not fire when MX is false/null, SPF is true/null, or mailDns is missing", () => {
    for (const m of [{ hasMx: false, hasSpf: false }, { hasMx: null, hasSpf: false }, { hasMx: true, hasSpf: true }, { hasMx: true, hasSpf: null },
      { hasMx: null, hasSpf: null }, { hasMx: false, hasSpf: null }, null, undefined])
      expect(hit(run(m)), JSON.stringify(m)).toBeUndefined();
  });
  it("fires for a blocked site but not for unreachable, parked or no_website", () => {
    expect(hit(run({ hasMx: true, hasSpf: false }, "blocked"))).toBeDefined();
    for (const st of ["unreachable", "parked", "no_website"] as const) {
      const r = run({ hasMx: true, hasSpf: false }, st);
      expect(codes(r)).not.toContain("no_email_auth");
      expect(r.findings).toHaveLength(1);
    }
  });
  it("evidence is plain English: no SPF/DMARC/MX/DNS/record jargon beyond the exact phrase", () => {
    expect(EV.replace("sender-verification records", "")).not.toMatch(/spf|dmarc|\bmx\b|dns|record/i);
    expect(hit(run({ hasMx: true, hasSpf: false }))!.evidence).not.toMatch(/spf|dmarc|\bmx\b|dns|record(?!s that)/i);
  });
});
