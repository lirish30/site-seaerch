import { describe, expect, it } from "vitest";
import { score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";
import { severityFor } from "../src/worker/scoring/config";
import { urgencyOf } from "../src/worker/audit/provenance";
import { SCOPES } from "../src/worker/google/oauth";
import { healthWord, leadTier } from "../src/client/scoreView";
import { SEVERITY_LABELS } from "../src/client/reportView";
import { healthBands, healthWeights, HEALTH_RULES, LEAD_RULES, leadRuleRows, lowPriorityNote, SEVERITY_RULES, severityRows, TIER_CHIPS, URGENCY_RULES, urgencyRows } from "../src/client/scoreRules";
import { PERMISSIONS } from "../src/client/settingsView";
import type { Finding } from "../src/worker/types";

/** The "How scores work" page prints these numbers; each one is checked here against the code that really scores. */
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
const ps = (performanceScore: number): PageSpeedFacts => ({ performanceScore, lcpMs: 1800, cls: 0.02, mobileFriendly: true, seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] });
const run = (c: CrawlFacts, speed: number, business: { rating: number | null; reviewCount: number | null }, mobile: { overflowX: boolean; smallTextPct: number } | null = null) =>
  score({ siteStatus: "ok", crawl: c, pagespeed: ps(speed), now, mobile, business: { category: "Plumber", ...business } });

describe("lead score rules match the scorer", () => {
  it("(100 - health) x 0.85 is the whole score for a business with no reviews and no critical problem", () => {
    const r = run({ ...crawl, hasNav: false }, 60, { rating: null, reviewCount: null });
    expect(r.findings.some((f) => f.severity === "critical")).toBe(false);
    expect(r.score).toBe(Math.round((100 - r.health!) * LEAD_RULES.weakSite));
  });
  it("adds 5 per critical problem, at most 15", () => {
    const one = run({ ...crawl, https: false }, 95, { rating: null, reviewCount: null });
    const many = run({ ...crawl, https: false, hasContactForm: false, emailCount: 0, hasViewport: false }, 95, { rating: null, reviewCount: null }, { overflowX: true, smallTextPct: 0 });
    const critical = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.severity === "critical").length;
    expect(critical(one)).toBeGreaterThanOrEqual(1);
    for (const r of [one, many]) {
      const bonus = r.score - Math.round((100 - r.health!) * LEAD_RULES.weakSite);
      expect(Math.abs(bonus - Math.min(LEAD_RULES.criticalMax, critical(r) * LEAD_RULES.criticalEach))).toBeLessThanOrEqual(1);
    }
    expect(critical(many)).toBeGreaterThan(LEAD_RULES.criticalMax / LEAD_RULES.criticalEach);
  });
  it("adds 10 for 25+ reviews, 5 for 10+, and 5 for a 4.3 rating", () => {
    const at = (rating: number | null, reviewCount: number | null) => run(crawl, 90, { rating, reviewCount }).score;
    const none = at(null, null);
    const { reviewsStrong: strong, reviewsSome: some, rating } = LEAD_RULES;
    expect(at(null, strong.reviews)).toBe(none + strong.points);
    expect(at(null, strong.reviews - 1)).toBe(none + some.points);
    expect(at(null, some.reviews)).toBe(none + some.points);
    expect(at(null, some.reviews - 1)).toBe(none);
    expect(at(rating.atLeast, null)).toBe(none + rating.points);
    expect(at(rating.atLeast - 0.1, null)).toBe(none);
  });
  it("scores 100 for no website and 90 for a parked or unreachable one", () => {
    const at = (siteStatus: "no_website" | "parked" | "unreachable") => score({ siteStatus, crawl: null, pagespeed: null, now }).score;
    expect(at("no_website")).toBe(LEAD_RULES.noWebsite);
    expect(at("parked")).toBe(LEAD_RULES.parkedOrUnreachable);
    expect(at("unreachable")).toBe(LEAD_RULES.parkedOrUnreachable);
  });
  it("flags a lead low priority under the printed cut-off", () => {
    const healthy = run(crawl, 98, { rating: null, reviewCount: null });
    expect(healthy.score).toBeLessThan(LEAD_RULES.lowPriorityBelow);
    expect(healthy.lowPriority).toBe(true);
    expect(lowPriorityNote()).toContain(`Under ${LEAD_RULES.lowPriorityBelow}`);
  });
  it("prints the same numbers as the rules", () => {
    expect(leadRuleRows().map((r) => r.chip)).toEqual(["(100 − health) × 0.85", "+5 each, max 15", "+10 / +5", "+5", "= 100 or 90"]);
    expect(leadRuleRows()[2].text).toBe("Established business: 25+ reviews, or 10+ reviews.");
    expect(leadRuleRows()[3].text).toBe("Rated 4.3★ or higher.");
  });
});

describe("tiers, health and severity words match the code", () => {
  it("shows the tier cut-offs the badge uses", () => {
    expect(TIER_CHIPS.map((t) => t.chip)).toEqual(["60+", "25+", "<25"]);
    expect([59, 60].map(leadTier)).toEqual(["warm", "hot"]);
    expect([24, 25].map(leadTier)).toEqual(["cool", "warm"]);
  });
  it("shows the Poor / Fair / Good bands healthWord uses", () => {
    expect([HEALTH_RULES.poorBelow - 1, HEALTH_RULES.poorBelow, HEALTH_RULES.goodAt - 1, HEALTH_RULES.goodAt].map(healthWord)).toEqual(["Poor", "Fair", "Fair", "Good"]);
    expect(healthBands().map((b) => `${b.word} · ${b.range}`)).toEqual(["Poor · under 40", "Fair · 40–69", "Good · 70+"]);
  });
  it("lists the category weights the scorer blends, adding up to 100", () => {
    expect(healthWeights().map((w) => `${w.label} ${w.pct}%`)).toEqual(["Design 25%", "Content 20%", "Conversion 20%", "Mobile 15%", "Speed 10%", "Technical 10%"]);
    expect(healthWeights().reduce((s, w) => s + w.pct, 0)).toBe(100);
  });
  it("ranks a finding by its points the way severityFor does", () => {
    const { criticalAt, importantAt } = SEVERITY_RULES;
    expect([criticalAt, criticalAt - 1, importantAt, importantAt - 1].map(severityFor)).toEqual(["critical", "important", "important", "nice"]);
    expect(severityRows().map((r) => [r.range, r.report])).toEqual([
      ["30+ points", SEVERITY_LABELS.high], ["12–29 points", SEVERITY_LABELS.medium], ["under 12", SEVERITY_LABELS.low]]);
  });
  it("adds urgency 30 / 12 / 3 per finding, capped at 100", () => {
    const f = (severity: Finding["severity"]) => ({ severity }) as Finding;
    expect(urgencyOf([f("critical")])).toBe(URGENCY_RULES.critical);
    expect(urgencyOf([f("important")])).toBe(URGENCY_RULES.important);
    expect(urgencyOf([f("nice")])).toBe(URGENCY_RULES.nice);
    expect(urgencyOf(Array.from({ length: 10 }, () => f("critical")))).toBe(URGENCY_RULES.cap);
    expect(urgencyRows().map((r) => r.chip)).toEqual(["+30", "+12", "+3"]);
  });
});

describe("Google permissions on the Google page", () => {
  it("name exactly the scopes the app requests (and never gmail.send)", () => {
    const asked = SCOPES.filter((s) => s.includes("/auth/"));
    expect(PERMISSIONS.map((p) => `https://www.googleapis.com/auth/${p.scope}`).sort()).toEqual([...asked].sort());
    expect(SCOPES.join(" ")).not.toContain("gmail.send");
  });
});
