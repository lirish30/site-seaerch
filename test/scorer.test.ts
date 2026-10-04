import { describe, it, expect } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";
import type { AiReview } from "../src/worker/types";

const now = new Date("2026-10-02T00:00:00Z");
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0,
  hasNav: true, navItemCount: 6, hasFooter: true, hasH1: true, hasCta: true, hasSocialProof: true, hasBooking: false,
  hasOpenGraph: true, schemaTypes: ["LocalBusiness"], homeWordCount: 600, imagesMissingAltPct: 0, phoneVisible: true,
  pageKinds: ["about", "contact", "services", "portfolio", "team", "menu", "locations", "booking", "pricing", "shop", "events"], rendered: true,
};
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true };
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
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.02, mobileFriendly: false }, now });
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
      pagespeed: { performanceScore: 28, lcpMs: 7000, cls: 0.05, mobileFriendly: true }, now,
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
      pagespeed: { performanceScore: 45, lcpMs: 5000, cls: 0.1, mobileFriendly: false },
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
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, mobileFriendly: false }, now, mobile: { overflowX: false, smallTextPct: 0 } });
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
    expect(score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, hasTitle: false, schemaTypes: [], hasH1: false }, pagespeed: goodPs, now }).offer).toBe("seo_basics");
    expect(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 35, lcpMs: 6000, cls: 0.4, mobileFriendly: true }, now }).offer).toBe("performance");
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
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, schemaTypes: [] }, pagespeed: goodPs, now });
    expect(r.findings.map((f) => f.severity)).toEqual(["critical", "nice"]);
    expect(r.findings.every((f) => f.recommendation.length > 0)).toBe(true);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
});
