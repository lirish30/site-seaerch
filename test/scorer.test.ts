import { describe, it, expect } from "vitest";
import type { Finding } from "../src/worker/types";
import { capGroups, score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";

const now = new Date("2026-10-02T00:00:00Z");
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0, platform: "other",
};
const noLh = { seoScore: null, accessibilityScore: null, seoIssues: [], accessibilityIssues: [] };
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true, ...noLh };
const codes = (r: ReturnType<typeof score>) => r.findings.map((f) => f.code).sort();

describe("score", () => {
  it("no website → 100, new_site", () => {
    const r = score({ siteStatus: "no_website", crawl: null, pagespeed: null, now });
    expect(r.score).toBe(100);
    expect(r.offer).toBe("new_site");
    expect(codes(r)).toEqual(["no_website"]);
  });

  it("parked and unreachable → 90, new_site", () => {
    expect(score({ siteStatus: "parked", crawl: null, pagespeed: null, now }).score).toBe(90);
    expect(score({ siteStatus: "unreachable", crawl: null, pagespeed: null, now }).offer).toBe("new_site");
  });

  it("blocked without PageSpeed → 0, no site-level 'didn't load' finding, care_plan", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: null, now });
    expect(r.score).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.offer).toBe("care_plan");
  });

  it("blocked with PageSpeed → scored from PageSpeed only", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.02, mobileFriendly: false, ...noLh }, now });
    expect(codes(r)).toEqual(["not_mobile_friendly", "slow_lcp", "slow_mobile"]);
    expect(r.findings.every((f) => f.group !== "site")).toBe(true);
    expect(r.offer).toBe("performance");
  });

  it("healthy site → 0, low priority", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: goodPs, now });
    expect(r.score).toBe(0);
    expect(r.lowPriority).toBe(true);
  });

  it("slow_mobile and meh_mobile are mutually exclusive", () => {
    const slow = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30 }, now });
    expect(codes(slow)).toEqual(["slow_mobile"]);
    const meh = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 60 }, now });
    expect(codes(meh)).toEqual(["meh_mobile"]);
    expect(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 70 }, now }).findings).toHaveLength(0);
  });

  it("speed-heavy site → performance offer", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.4, mobileFriendly: true, ...noLh }, now });
    expect(r.score).toBe(25 + 10 + 5);
    expect(r.offer).toBe("performance");
  });

  it("stale-heavy site → care_plan", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { ...goodCrawl, copyrightYear: 2023, latestContentDate: "2024-01-01", pastEventDates: ["2025-05-01"], brokenLinkCount: 4 },
      pagespeed: goodPs, now,
    });
    expect(codes(r)).toEqual(["broken_links", "old_copyright", "past_events", "stale_content"]);
    expect(r.score).toBe(33);
    expect(r.offer).toBe("care_plan");
  });

  it("copyright exactly current-2 counts, current-1 does not", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2024 }, pagespeed: goodPs, now }))).toContain("old_copyright");
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2025 }, pagespeed: goodPs, now }))).not.toContain("old_copyright");
  });

  it("basics only → seo_basics", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, hasTitle: false }, pagespeed: goodPs, now });
    expect(codes(r)).toEqual(["no_https", "no_title_or_meta"]);
    expect(r.offer).toBe("seo_basics");
  });

  it("no_contact_form only when no form AND no email", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 1 }, pagespeed: goodPs, now }))).toEqual([]);
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 0 }, pagespeed: goodPs, now }))).toEqual(["no_contact_form"]);
  });

  it("not mobile friendly + stale → new_site", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false, copyrightYear: 2018 }, pagespeed: goodPs, now });
    expect(r.offer).toBe("new_site");
  });

  it("missing viewport counts as not_mobile_friendly even without pagespeed; partial input works", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false }, pagespeed: null, now });
    expect(codes(r)).toEqual(["not_mobile_friendly"]);
  });

  it("ties break speed > stale > basics", () => {
    // speed 10 (slow_lcp) vs stale 10 (old_copyright)
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2020 }, pagespeed: { ...goodPs, lcpMs: 5000 }, now });
    expect(r.offer).toBe("performance");
  });

  it("caps at 100", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { https: false, hasTitle: false, hasMetaDescription: false, hasViewport: false, hasContactForm: false, emailCount: 0,
        copyrightYear: 2010, latestContentDate: "2015-01-01", pastEventDates: ["2020-01-01"], brokenLinkCount: 10, platform: "other" },
      pagespeed: { performanceScore: 10, lcpMs: 9000, cls: 0.9, mobileFriendly: false, ...noLh }, now,
    });
    expect(r.score).toBe(100);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
  describe("lighthouse seo + accessibility", () => {
    const run = (ps: Partial<PageSpeedFacts> | null, crawl: CrawlFacts | null = goodCrawl) =>
      score({ siteStatus: "ok", crawl, pagespeed: ps ? { ...goodPs, ...ps } : null, now });
    const find = (r: ReturnType<typeof score>, code: string) => r.findings.find((f) => f.code === code);

    it("low_seo_score fires below 70, not at 70", () => {
      expect(codes(run({ seoScore: 69 }))).toEqual(["low_seo_score"]);
      expect(codes(run({ seoScore: 70 }))).toEqual([]);
      expect(find(run({ seoScore: 69 }), "low_seo_score")).toMatchObject({ group: "seo", points: 12, severity: "medium" });
    });

    it("low_accessibility fires below 70, not at 70", () => {
      expect(codes(run({ accessibilityScore: 69 }))).toEqual(["low_accessibility"]);
      expect(codes(run({ accessibilityScore: 70 }))).toEqual([]);
      expect(find(run({ accessibilityScore: 0 }), "low_accessibility")).toMatchObject({ group: "basics", points: 6, severity: "low" });
    });

    it("no findings when pagespeed is missing or the scores are null", () => {
      expect(run(null).findings).toEqual([]);
      expect(run({ seoScore: null, accessibilityScore: null, seoIssues: ["no page title"], accessibilityIssues: ["no page language set"] }).findings).toEqual([]);
    });

    it("seo evidence: first three issues, or the score when there are none", () => {
      expect(find(run({ seoScore: 40, seoIssues: ["a", "b", "c", "d"] }), "low_seo_score")!.evidence)
        .toBe("Google's own check found problems that hurt how the site shows up in search: a, b, c");
      expect(find(run({ seoScore: 40, seoIssues: ["no page title"] }), "low_seo_score")!.evidence)
        .toBe("Google's own check found problems that hurt how the site shows up in search: no page title");
      expect(find(run({ seoScore: 40 }), "low_seo_score")!.evidence)
        .toBe("Google's own check scored the site's search-friendliness at 40/100");
    });

    it("accessibility evidence: first two issues, or generic when there are none", () => {
      expect(find(run({ accessibilityScore: 50, accessibilityIssues: ["a", "b", "c"] }), "low_accessibility")!.evidence)
        .toBe("Parts of the site are hard to read or use for some visitors (a, b)");
      expect(find(run({ accessibilityScore: 50, accessibilityIssues: ["a"] }), "low_accessibility")!.evidence)
        .toBe("Parts of the site are hard to read or use for some visitors (a)");
      expect(find(run({ accessibilityScore: 50 }), "low_accessibility")!.evidence)
        .toBe("Parts of the site are hard to read or use for some visitors");
    });

    it("evidence stays free of jargon and legal claims", () => {
      const r = run({ seoScore: 10, accessibilityScore: 10 });
      for (const f of r.findings) expect(f.evidence).not.toMatch(/ADA|complian|lighthouse|lawsuit|legal/i);
    });

    it("seo points push the offer to seo_basics", () => {
      // speed 10 (slow_lcp) beats basics 6 (no_contact_form)...
      const base = { ...goodCrawl, hasContactForm: false, emailCount: 0 };
      expect(run({ lcpMs: 5000 }, base).offer).toBe("performance");
      // ...until seo (12) is added to the basics bucket: 18 > 10.
      expect(run({ lcpMs: 5000, seoScore: 30 }, base).offer).toBe("seo_basics");
      // seo alone also yields seo_basics
      expect(run({ seoScore: 30 }).offer).toBe("seo_basics");
    });

    it("new_site rule is unchanged by seo findings", () => {
      expect(run({ seoScore: 30 }, { ...goodCrawl, hasViewport: false }).offer).toBe("performance"); // speed 20 > seo 12, no stale
      expect(run({ seoScore: 30 }, { ...goodCrawl, hasViewport: false, copyrightYear: 2018 }).offer).toBe("new_site");
    });
  });

  describe("capGroups", () => {
    const fi = (group: Finding["group"], points: number): Finding => ({ code: "low_seo_score", group, severity: "low", points, evidence: "" });
    it("caps seo and local group sums, leaves other groups uncapped", () => {
      expect(capGroups([fi("seo", 12), fi("seo", 12), fi("speed", 25), fi("speed", 25), fi("speed", 25)])).toBe(20 + 75);
      expect(capGroups([fi("local", 10), fi("local", 10)])).toBe(15);
      expect(capGroups([fi("seo", 12), fi("local", 10)])).toBe(22);
      expect(capGroups([fi("seo", 8), fi("seo", 8)])).toBe(16);
    });
  });
});
