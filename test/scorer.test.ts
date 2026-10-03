import { describe, it, expect } from "vitest";
import type { Finding } from "../src/worker/types";
import { AUDIT_LABELS } from "../src/worker/scoring/labels";
import { capGroups, score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";

const now = new Date("2026-10-02T00:00:00Z");
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0, platform: "other",
};
const noLh = { seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] };
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
      // seo with only image-alt falls back to the score sentence
      expect(find(run({ seoScore: 40, seoIssueIds: ["image-alt"] }), "low_seo_score")!.evidence).toContain("40/100");
    });

    it("drops title/summary ids from seo evidence when the crawler already reported them", () => {
      const ids = ["document-title", "meta-description", "link-text"];
      const crawled = run({ seoScore: 40, seoIssueIds: ids }, { ...goodCrawl, hasTitle: false });
      expect(codes(crawled)).toEqual(["low_seo_score", "no_title_or_meta"]);
      expect(find(crawled, "low_seo_score")!.evidence).toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here'");
      const only = run({ seoScore: 40, seoIssueIds: ["meta-description"] }, { ...goodCrawl, hasMetaDescription: false });
      expect(find(only, "low_seo_score")!.evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
      // crawler saw both, so PageSpeed's version is kept; likewise with no crawl at all
      expect(find(run({ seoScore: 40, seoIssueIds: ids }), "low_seo_score")!.evidence).toContain("no page title, no search-results summary");
      expect(find(run({ seoScore: 40, seoIssueIds: ids }, null), "low_seo_score")!.evidence).toContain("no page title");
    });

    it("blocked site: scored from PageSpeed only, and is-crawlable is not claimed", () => {
      const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable", "link-text"] }, now });
      expect(codes(r)).toEqual(["low_seo_score"]);
      expect(r.score).toBe(12);
      expect(r.offer).toBe("seo_basics");
      expect(r.findings[0].evidence).not.toContain("blocked from Google");
      expect(r.findings[0].evidence).toContain("links that just say");
      const only = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable"] }, now });
      expect(only.findings[0].evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
      // a normally crawled site keeps it
      expect(find(run({ seoScore: 40, seoIssueIds: ["is-crawlable"] }), "low_seo_score")!.evidence).toContain("blocked from Google");
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
