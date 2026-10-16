import { describe, expect, it } from "vitest";
import { dueBadge, filterItems, filterPills, itemLink, itemReason, KIND_VIEW } from "../src/client/todayView";
import { ago, dayLine, greeting, kpiCards, leftLabel, limitLabel, moneyShort, moneyWhole, pipelineRows, radarNext, runningCard, spendView, type TodaySummary } from "../src/client/todayHome";
import type { Search, TodayItem, TodayKind } from "../src/client/types";

const item = (kind: TodayKind, businessId = "b", extra: Partial<TodayItem> = {}): TodayItem =>
  ({ id: `${kind}:${businessId}`, kind, businessId, businessName: businessId, reason: "r", due: null, priority: 1, ...extra });
const summary = (over: Partial<TodaySummary> = {}): TodaySummary => ({
  hot: { total: 24, newThisWeek: 6 }, drafts: { ready: 11, waiting: 4 }, replied: { total: 7, thisWeek: 3 }, won: { thisMonth: 2, valueThisMonth: 9400, openValue: 18200 },
  pipeline: { new: 86, reviewed: 32, contacted: 18, replied: 7, won: 4, lost: 3, skip: 2 }, totalLeads: 152, fullScanCostUsd: 0.0455, recent: [], ...over,
});
const at = (h: number) => new Date(2026, 9, 15, h, 30);

describe("Home rows", () => {
  it("gives every kind a label, icon, tone, pill and action, and sends a draft to the email tab", () => {
    for (const k of Object.keys(KIND_VIEW) as TodayKind[]) expect(KIND_VIEW[k].label && KIND_VIEW[k].pill && KIND_VIEW[k].action).toBeTruthy();
    expect(itemLink(item("follow_up_due", "a b"))).toBe("/leads/a b");
    expect(itemLink(item("draft_unsent", "x"))).toBe("/leads/x?tab=email");
    expect(itemLink(item("promising_quick_scan"))).toBeNull();
  });
  it("counts each filter pill, hiding Saved until something is saved", () => {
    const items = [item("follow_up_due", "1"), item("follow_up_due", "2"), item("draft_unsent"), item("stalled_deal"), item("promising_quick_scan")];
    expect(filterPills(items).map((p) => `${p.label} ${p.count}`)).toEqual(["All 5", "Follow-ups 2", "Drafts 1", "Deals 1", "Scans 1"]);
    expect(filterPills([...items, item("starred_idle")]).at(-1)).toEqual({ key: "starred_idle", label: "Saved", count: 1 });
    expect(filterPills([]).map((p) => p.count)).toEqual([0, 0, 0, 0, 0]);
    expect(filterItems(items, "follow_up_due")).toHaveLength(2);
    expect(filterItems(items, "all")).toHaveLength(5);
  });
  it("badges a follow-up as N days late (red) or due today (amber), and nothing else", () => {
    const now = at(9);
    expect(dueBadge(item("follow_up_due", "b", { due: "2026-10-12" }), now)).toEqual({ tone: "critical", label: "3 days late" });
    expect(dueBadge(item("follow_up_due", "b", { due: "2026-10-14T00:00:00.000Z" }), now)).toEqual({ tone: "critical", label: "1 day late" });
    expect(dueBadge(item("follow_up_due", "b", { due: "2026-10-15" }), now)).toEqual({ tone: "warning", label: "Due today" });
    expect(dueBadge(item("follow_up_due", "b", { due: null }), now)).toBeNull();
    expect(dueBadge(item("stalled_deal", "b", { due: "2026-10-12" }), now)).toBeNull();
  });
  it("adds the contact date to a follow-up and the scan price to a quick scan, and leaves other reasons alone", () => {
    expect(itemReason({ kind: "follow_up_due", reason: "Follow-up was due 3 days ago" }, { contactedAt: "2026-10-02T15:00:00Z" })).toMatch(/^Follow-up was due 3 days ago · contacted Oct [12]$/);
    expect(itemReason({ kind: "follow_up_due", reason: "R" }, { contactedAt: null })).toBe("R");
    expect(itemReason({ kind: "promising_quick_scan", reason: "R" }, { score: 72, fullScanCostUsd: 0.0455 })).toBe("Quick scan scored 72 · full scan ≈ $0.05");
    expect(itemReason({ kind: "promising_quick_scan", reason: "R" }, {})).toBe("R");
    expect(itemReason({ kind: "draft_unsent", reason: "R" }, { score: 1 })).toBe("R");
  });
});

describe("Home numbers", () => {
  it("writes the greeting and the day line", () => {
    expect(greeting("Logan Irish", at(9))).toBe("Good morning, Logan");
    expect(greeting("", at(14))).toBe("Good afternoon");
    expect(greeting(" Sam ", at(20))).toBe("Good evening, Sam");
    expect(dayLine(9, at(9))).toMatch(/^\w+, October 15 · 9 things need you today$/);
    expect(dayLine(1, at(9))).toMatch(/1 thing needs you today$/);
    expect(dayLine(0, at(9))).toMatch(/nothing needs you today$/);
    expect(dayLine(null, at(9))).toMatch(/^\w+, October 15$/);
  });
  it("formats money for headlines, small print and spend", () => {
    expect(moneyWhole(9400)).toBe("$9,400");
    expect([moneyShort(950), moneyShort(18200), moneyShort(18000), moneyShort(1_250_000)]).toEqual(["$950", "$18.2k", "$18k", "$1.3M"]);
    expect(limitLabel(150)).toBe("$150");
    expect(limitLabel(37.5)).toBe("$37.50");
  });
  it("builds the four KPI cards from the summary, going grey instead of showing +0", () => {
    const k = kpiCards(summary());
    expect(k.map((c) => [c.label, c.value, c.sub, c.tone])).toEqual([
      ["Hot leads", "24", "+6 this week", "positive"], ["Drafts ready to send", "11", "4 waiting 2+ days", "warning"],
      ["In conversation", "7", "3 replied this week", "positive"], ["Won this month", "$9,400", "2 deals · $18.2k open", "muted"],
    ]);
    const quiet = kpiCards(summary({ hot: { total: 3, newThisWeek: 0 }, drafts: { ready: 2, waiting: 0 }, replied: { total: 0, thisWeek: 0 }, won: { thisMonth: 1, valueThisMonth: 0, openValue: 0 } }));
    expect(quiet.map((c) => [c.sub, c.tone])).toEqual([["None new this week", "muted"], ["None waiting 2+ days", "muted"], ["No replies this week", "muted"], ["1 deal · $0 open", "muted"]]);
    expect(kpiCards(summary({ drafts: { ready: 0, waiting: 0 } }))[1].sub).toBe("Nothing waiting");
  });
  it("lists the five pipeline stages and totals them (lost and skipped are not in the pipeline)", () => {
    const p = pipelineRows(summary().pipeline);
    expect(p.rows.map((r) => [r.label, r.count])).toEqual([["New", 86], ["Reviewed", 32], ["Contacted", 18], ["Replied", 7], ["Won", 4]]);
    expect(p.total).toBe(147);
  });
  it("splits spend into three lines, keeps unknown services in the total, and flags going over the limit", () => {
    const v = spendView([{ service: "brightdata", units: 1, est_cost_usd: 12.4 }, { service: "claude", units: 1, est_cost_usd: 20 }, { service: "claude_cro", units: 1, est_cost_usd: 4.1 },
      { service: "browser", units: 1, est_cost_usd: 4.7 }, { service: "newthing", units: 1, est_cost_usd: 1 }], 150);
    expect(v.rows.map((r) => [r.label, +r.usd.toFixed(2)])).toEqual([["Google Maps listings", 12.4], ["AI reviews & drafts", 24.1], ["Browser checks", 5.7]]);
    expect(+v.total.toFixed(2)).toBe(42.2);
    expect(spendView([{ service: "brightdata", units: 1, est_cost_usd: 1 }, { service: "places", units: 1, est_cost_usd: 2 }], 150).rows[0]).toMatchObject({ label: "Google Maps listings", usd: 3 });
    expect(v.pct).toBeCloseTo(28.13, 1);
    expect(v.over).toBe(false);
    expect(spendView([{ service: "claude", units: 1, est_cost_usd: 200 }], 150)).toMatchObject({ pct: 100, over: true });
    expect(spendView([], 0)).toMatchObject({ total: 0, pct: 0, over: false });
  });
});

describe("Home sidebar", () => {
  const search = (o: Partial<Search>): Search => ({ id: "s", location: "Boise, ID", business_type: "plumber", max_results: 50, status: "running", error: null, fetch_attempts: 0, found_count: 0, processed_count: 0, created_at: new Date(1_000_000_000_000).toISOString(), new_only: 0, quick_scan: 0, ...o });
  it("shows a search with no listings yet as finding listings at a small bar", () => {
    expect(runningCard(search({}), 1_000_000_020_000)).toEqual({ title: "Plumber in Boise, ID", status: "Finding listings on Google Maps…", pct: 15, finding: true });
  });
  it("shows progress and time left for an auditing search", () => {
    const c = runningCard(search({ found_count: 50, processed_count: 34, created_at: new Date(1_000_000_000_000 - 442_000).toISOString() }), 1_000_000_000_000);
    expect(c).toMatchObject({ title: "Plumber in Boise, ID", status: "34 of 50 audited · 3 min left", pct: 68, finding: false });
  });
  it("words the time left", () => {
    expect([leftLabel(null), leftLabel(20), leftLabel(180)]).toEqual([null, "under a minute left", "3 min left"]);
  });
  it("says when a radar fires next, or that it is paused", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(radarNext({ enabled: 1, next_run_at: "2026-10-17T00:00:00Z" }, now)).toBe("in 2d");
    expect(radarNext({ enabled: 1, next_run_at: "2026-10-15T01:00:00Z" }, now)).toBe("today");
    expect(radarNext({ enabled: 0, next_run_at: "2026-10-17T00:00:00Z" }, now)).toBe("paused");
  });
});

describe("ago", () => {
  it("counts back from now", () => {
    const now = Date.parse("2026-10-15T12:00:00Z"), t = (ms: number) => new Date(now - ms).toISOString();
    expect([ago(t(10_000), now), ago(t(5 * 60_000), now), ago(t(3 * 3_600_000), now), ago(t(2 * 86_400_000), now)]).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
    expect(ago(t(30 * 86_400_000), now)).toMatch(/^Sep \d+$/);
    expect(ago("nope", now)).toBe("");
  });
});
