import { describe, expect, it } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";
import { followUpLabel, followUpTone } from "../src/client/leadView";
import { sectionOf, sidebarOf, stageCounts } from "../src/client/navView";
import { healthWord, initials, leadTier, scoreBreakdown, severityCounts, tierSummary, urgencyWord } from "../src/client/scoreView";
import type { LeadRow } from "../src/client/types";

describe("lead tiers and health words", () => {
  it("cuts Hot at 60, Warm at 25", () => {
    expect([100, 60, 59, 25, 24, 0].map(leadTier)).toEqual(["hot", "hot", "warm", "warm", "cool", "cool"]);
  });
  it("calls site health Poor under 40, Fair under 70, otherwise Good", () => {
    expect([0, 39, 40, 69, 70, 100].map(healthWord)).toEqual(["Poor", "Poor", "Fair", "Fair", "Good", "Good"]);
  });
  it("words urgency from its 0-100 value", () => {
    expect([0, 29, 30, 59, 60, 100].map(urgencyWord)).toEqual(["Low", "Low", "Medium", "Medium", "High", "High"]);
  });
});

const now = new Date("2026-10-02T00:00:00Z");
const base = {
  platform: "other" as const, h1Count: 1, wordCount: 600, imageCount: 0, imagesMissingAlt: 0, hasPhone: true, hasTelLink: true,
  hasLocalBusinessSchema: true, mixedContentCount: 0, datedBuildMarkers: [] as string[], isLikelyJsRendered: false,
  hasRobotsTxt: true, hasSitemap: true, httpRedirectsToHttps: true,
};
const crawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0,
  hasNav: true, navItemCount: 6, hasFooter: true, hasH1: true, hasCta: true, hasSocialProof: true, hasBooking: false,
  hasOpenGraph: true, schemaTypes: ["LocalBusiness"], homeWordCount: 600, imagesMissingAltPct: 0, phoneVisible: true,
  pageKinds: ["about", "contact", "services", "portfolio", "team", "menu", "locations", "booking", "pricing", "shop", "events"], rendered: true,
  ...base,
};
const noLh = { seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] };
const ps = (performanceScore: number): PageSpeedFacts => ({ performanceScore, lcpMs: 1800, cls: 0.02, mobileFriendly: true, ...noLh });

/** The breakdown must reproduce the scorer's own lead score, so the lead page never disagrees with the list. */
describe("scoreBreakdown matches the scorer", () => {
  const cases: [string, Parameters<typeof score>[0], { rating: number | null; reviewCount: number | null }][] = [
    ["healthy site, well reviewed", { siteStatus: "ok", crawl, pagespeed: ps(95), now }, { rating: 4.8, reviewCount: 400 }],
    ["weak site, many reviews", { siteStatus: "ok", crawl: { ...crawl, https: false, hasContactForm: false, emailCount: 0, hasCta: false, hasViewport: false, homeWordCount: 40 }, pagespeed: ps(30), now }, { rating: 4.6, reviewCount: 5649 }],
    ["weak site, few reviews", { siteStatus: "ok", crawl: { ...crawl, https: false, hasNav: false, hasFooter: false, copyrightYear: 2015 }, pagespeed: ps(45), now }, { rating: 3.9, reviewCount: 12 }],
    ["mid reviews, high rating", { siteStatus: "ok", crawl: { ...crawl, hasCta: false }, pagespeed: ps(70), now }, { rating: 4.3, reviewCount: 10 }],
    ["no reviews at all", { siteStatus: "ok", crawl: { ...crawl, hasSocialProof: false }, pagespeed: ps(88), now }, { rating: null, reviewCount: null }],
  ];
  for (const [name, input, biz] of cases) {
    it(name, () => {
      const r = score({ ...input, business: { category: "Plumber", ...biz } });
      const b = scoreBreakdown({ score: r.score, health: r.health, findings: r.findings, siteStatus: "ok", reviewCount: biz.reviewCount, rating: biz.rating });
      expect(b.total).toBe(r.score);
      expect(b.parts.reduce((s, p) => s + p.points, 0)).toBe(r.score);
      // No unexplained remainder: every case here is the weak-website + critical + established formula.
      expect(b.parts.map((p) => p.key).filter((k) => k === "other")).toEqual([]);
    });
  }

  it("shows a missing website as one part worth the whole score", () => {
    for (const siteStatus of ["no_website", "parked", "unreachable"] as const) {
      const r = score({ siteStatus, crawl: null, pagespeed: null, now });
      const b = scoreBreakdown({ score: r.score, health: r.health, findings: r.findings, siteStatus, reviewCount: 300, rating: 4.9 });
      expect(b.parts).toHaveLength(1);
      expect(b.parts[0]).toMatchObject({ key: "nosite", points: r.score });
    }
  });

  it("caps at 100 instead of showing parts that add up to more", () => {
    const b = scoreBreakdown({ score: 100, health: 5, findings: Array(4).fill({ severity: "critical" }), siteStatus: "ok", reviewCount: 100, rating: 4.9 });
    expect(b.parts.reduce((s, p) => s + p.points, 0)).toBe(100);
    expect(b.parts.at(-1)).toMatchObject({ key: "other", label: "Capped at 100" });
  });

  it("absorbs a one point rounding difference into the weak-website part", () => {
    const b = scoreBreakdown({ score: 57, health: 34, findings: [], siteStatus: "ok", reviewCount: null, rating: null });
    expect(b.parts.map((p) => p.points)).toEqual([57, 0, 0]);
  });
});

describe("tierSummary", () => {
  it("mentions an established business only when that part is worth 10 or more", () => {
    const est = scoreBreakdown({ score: 86, health: 34, findings: [], siteStatus: "ok", reviewCount: 5000, rating: 4.8 });
    expect(tierSummary("hot", est)).toMatch(/established/);
    const none = scoreBreakdown({ score: 62, health: 28, findings: [], siteStatus: "ok", reviewCount: 2, rating: 3.5 });
    expect(tierSummary("hot", none)).not.toMatch(/established/);
  });
});

describe("small helpers", () => {
  it("counts severities and takes initials", () => {
    expect(severityCounts([{ severity: "critical" }, { severity: "nice" }, { severity: "critical" }])).toEqual({ critical: 2, important: 0, nice: 1 });
    expect(initials("Perfect Plumbing Heating & Air")).toBe("PP");
    expect(initials("  ")).toBe("?");
    expect(initials("Café")).toBe("C");
  });
  it("reads follow-up dates against today", () => {
    const now = new Date(2026, 9, 15);
    expect([null, "2026-10-12", "2026-10-15", "2026-10-20"].map((d) => followUpTone(d, now))).toEqual(["none", "overdue", "today", "later"]);
    expect(followUpLabel("2026-10-12", now)).toMatch(/3 days late$/);
    expect(followUpLabel("2026-10-15", now)).toMatch(/today$/);
    expect(followUpLabel("2026-10-16", now)).toMatch(/in 1 day$/);
  });
});

describe("navigation mapping", () => {
  it("puts every existing route in a section", () => {
    const map: [string, string][] = [
      ["/today", "home"], ["/jobs", "home"], ["/leads", "leads"], ["/leads/abc", "leads"], ["/promising", "leads"], ["/outreach", "outreach"],
      ["/", "find"], ["/searches", "find"], ["/searches/s1", "find"], ["/radar", "find"], ["/import", "find"], ["/settings", "settings"], ["/settings/voice", "settings"],
    ];
    for (const [path, section] of map) expect(sectionOf(path), path).toBe(section);
  });
  it("gives a sidebar to list pages only", () => {
    expect(["/leads", "/promising"].map(sidebarOf)).toEqual(["leads", "leads"]);
    expect(["/", "/radar", "/import", "/searches", "/searches/s1"].map(sidebarOf)).toEqual(["find", "find", "find", "find", "find"]);
    expect(["/today", "/jobs", "/outreach", "/settings", "/settings/voice"].map(sidebarOf)).toEqual(["home", "home", "outreach", "settings", "settings"]);
    expect(sidebarOf("/leads/abc")).toBeNull();
  });
  it("counts stages and starred from the rows", () => {
    const row = (lead_status: string, starred_at: string | null) => ({ business: { lead_status, starred_at } }) as unknown as LeadRow;
    const c = stageCounts([row("new", null), row("new", "x"), row("won", null)]);
    expect(c).toMatchObject({ all: 3, starred: 1 });
    expect(c.byStatus).toMatchObject({ new: 2, won: 1, lost: 0 });
  });
});
