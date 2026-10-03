import { describe, it, expect } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";

const now = new Date("2026-10-02T00:00:00Z");
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0,
};
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true };
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
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.02, mobileFriendly: false }, now });
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
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.4, mobileFriendly: true }, now });
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
        copyrightYear: 2010, latestContentDate: "2015-01-01", pastEventDates: ["2020-01-01"], brokenLinkCount: 10 },
      pagespeed: { performanceScore: 10, lcpMs: 9000, cls: 0.9, mobileFriendly: false }, now,
    });
    expect(r.score).toBe(100);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
});
