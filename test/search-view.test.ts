import { describe, it, expect } from "vitest";
import {
  barPercent, DEFAULT_HISTORY_FILTERS, failureReason, filterSearches, fullScanButtonText, fullScanTargets, leftText, metaLine, radarFor, radarLabel,
  rowStatuses, runState, runningLine, scanLabel, searchTitle, sortResults, startedLabel, tierCounts, usd,
} from "../src/client/searchView";
import { STOPPED_ERROR } from "../src/worker/search-stop";
import type { LeadRow, Radar, Search } from "../src/client/types";

const NOW = new Date(2026, 9, 15, 12, 0, 0); // Oct 15 2026, local noon
const at = (m: number, d: number, h = 9, min = 12) => new Date(2026, m, d, h, min).toISOString();
const search = (o: Partial<Search> = {}): Search => ({ id: "s", location: "Boise, ID", business_type: "plumber", max_results: 50, status: "done", error: null, found_count: 50, processed_count: 50,
  created_at: at(9, 15), new_only: 0, quick_scan: 0, ...o });
const lead = (o: { score?: number | null; err?: string | null; site?: string | null; stage?: "quick" | "full"; name?: string }): LeadRow => ({
  business: { id: o.name ?? "x", name: o.name ?? "x", website_url: o.site === undefined ? "https://x.com" : o.site, last_error: o.err ?? null } as LeadRow["business"],
  score: o.score === undefined ? null : o.score, scan_stage: o.stage ?? "full" } as LeadRow);

describe("run state and labels", () => {
  it("tells a stopped search from a failed one", () => {
    expect(runState(search({ status: "failed", error: STOPPED_ERROR }))).toBe("stopped");
    expect(runState(search({ status: "failed", error: "boom" }))).toBe("failed");
    expect(runState(search({ status: "running" }))).toBe("running");
    expect(runState(search())).toBe("done");
  });
  it("titles, scans and imports", () => {
    expect(searchTitle(search())).toBe("Plumber in Boise, ID");
    expect(searchTitle(search({ business_type: "import", location: "Import leads.csv" }))).toBe("Import leads.csv");
    expect(scanLabel(search({ quick_scan: 1 }))).toBe("Quick");
    expect(scanLabel(search())).toBe("Full");
    expect(scanLabel(search({ business_type: "import" }))).toBe("—");
  });
  it("words when a search started", () => {
    expect(startedLabel(search({ created_at: at(9, 15, 9, 12) }), NOW)).toBe("Today, 9:12 am");
    expect(startedLabel(search({ created_at: at(9, 13, 15, 5), new_only: 1 }), NOW)).toBe("Oct 13 · Radar run");
    expect(startedLabel(search({ created_at: new Date(2025, 8, 29).toISOString() }), NOW)).toBe("Sep 29, 2025");
  });
  it("words the progress header", () => {
    expect(metaLine(search({ status: "running", found_count: 0, processed_count: 0, quick_scan: 1, created_at: at(9, 15) }), NOW)).toBe("Started today at 9:12 am · up to 50 businesses · quick scan");
    expect(metaLine(search({ created_at: at(9, 13), new_only: 1, found_count: 31 }), NOW)).toBe("Started Oct 13 at 9:12 am · 31 businesses found · full scan · radar run");
    expect(metaLine(search({ status: "running", found_count: 12 }), NOW)).toContain("up to 50 businesses");
    expect(metaLine(search({ found_count: 1 }), NOW)).toContain("1 business found");
  });
  it("formats the time left and money", () => {
    expect(leftText(20)).toBe("under a minute left");
    expect(leftText(190)).toBe("3 min left");
    expect(usd(0.8)).toBe("$0.80");
  });
});

describe("running progress", () => {
  it("says finding listings until some arrive, then counts audited leads", () => {
    expect(runningLine(search({ status: "running", found_count: 0, processed_count: 0 }), NOW.getTime())).toBe("Finding listings…");
    const s = search({ status: "running", found_count: 50, processed_count: 34, created_at: new Date(NOW.getTime() - 252_000).toISOString() });
    expect(runningLine(s, NOW.getTime())).toMatch(/^34 of 50 audited · (under a minute|\d+ min) left$/);
  });
  it("fills the bar from audited over found, with a stub while fetching and full when done", () => {
    expect(barPercent(search({ status: "running", found_count: 0, processed_count: 0 }))).toBe(12);
    expect(barPercent(search({ status: "running", found_count: 50, processed_count: 34 }))).toBe(68);
    expect(barPercent(search())).toBe(100);
  });
});

describe("failure reasons", () => {
  it("reads the stored error", () => {
    expect(failureReason({ error: null })).toBe("Something went wrong");
    expect(failureReason({ error: "spend limit" })).toBe("Monthly spend limit reached");
    expect(failureReason({ error: STOPPED_ERROR })).toBe("Stopped before it finished");
    expect(failureReason({ error: "Google Maps failed 3 times" })).toBe("Google Maps failed 3 times");
    expect(failureReason({ error: "x".repeat(300) })).toHaveLength(140);
  });
});

describe("radar", () => {
  const radar = (o: Partial<Radar> = {}): Radar => ({ id: "r", location: "boise, id", business_type: "Plumber", max_results: 50, interval_days: 30, enabled: 1, next_run_at: "", last_run_at: null, last_search_id: null, last_error: null, created_at: "", newLeadCount: 0, lastSearchStatus: null, ...o });
  it("matches a search to its radar ignoring case, and labels it", () => {
    expect(radarFor(search(), [radar({ id: "other", location: "Nampa, ID" }), radar()])?.id).toBe("r");
    expect(radarFor(search({ location: "Eagle, ID" }), [radar()])).toBeNull();
    expect(radarLabel(radar())).toBe("Every 30d");
    expect(radarLabel(radar({ enabled: 0 }))).toBe("Paused");
  });
});

describe("history filters", () => {
  const rows = [
    search({ id: "a", created_at: at(9, 15) }),
    search({ id: "b", business_type: "dentist", location: "Meridian, ID", quick_scan: 1, status: "running", created_at: at(9, 14) }),
    search({ id: "c", status: "failed", error: "boom", created_at: at(8, 8) }),
    search({ id: "d", status: "failed", error: STOPPED_ERROR, created_at: at(5, 1) }),
    search({ id: "e", business_type: "import", location: "Import a.csv", created_at: at(9, 1) }),
  ];
  const ids = (f: Partial<typeof DEFAULT_HISTORY_FILTERS>) => filterSearches(rows, { ...DEFAULT_HISTORY_FILTERS, ...f }, NOW).map((s) => s.id);
  it("defaults to the last 90 days", () => expect(ids({})).toEqual(["a", "b", "c", "e"]));
  it("filters by started window", () => { expect(ids({ started: "7" })).toEqual(["a", "b"]); expect(ids({ started: "all" })).toEqual(["a", "b", "c", "d", "e"]); });
  it("filters by status, treating stopped as its own", () => { expect(ids({ status: "failed", started: "all" })).toEqual(["c"]); expect(ids({ status: "stopped", started: "all" })).toEqual(["d"]); });
  it("filters by scan, leaving imports out of both", () => { expect(ids({ scan: "quick" })).toEqual(["b"]); expect(ids({ scan: "full" })).toEqual(["a", "c"]); });
  it("searches the title", () => { expect(ids({ q: "  MERIDIAN " })).toEqual(["b"]); expect(ids({ q: "plumber in boise" })).toEqual(["a", "c"]); });
});

describe("results", () => {
  const rows = [lead({ name: "q1" }), lead({ name: "hot", score: 86 }), lead({ name: "err", err: "boom" }), lead({ name: "cool", score: 22 }), lead({ name: "q2" }), lead({ name: "warm", score: 40 })];
  it("sorts audited leads best first, then failures, then the rest in arrival order", () => {
    expect(sortResults(rows).map((r) => r.business.name)).toEqual(["hot", "warm", "cool", "err", "q1", "q2"]);
  });
  it("marks audited, failed, auditing and queued leads while running", () => {
    const many = [lead({ score: 50 }), ...Array.from({ length: 7 }, () => lead({}))];
    expect(rowStatuses(many, true)).toEqual(["audited", "auditing", "auditing", "auditing", "auditing", "auditing", "queued", "queued"]);
    expect(rowStatuses([lead({ err: "x" }), lead({})], true)).toEqual(["failed", "auditing"]);
  });
  it("calls an unaudited lead idle once the search is over", () => expect(rowStatuses([lead({})], false)).toEqual(["idle"]));
  it("counts tiers, no-website and failed leads", () => {
    expect(tierCounts([...rows, lead({ score: 100, site: null }), lead({ score: 60 }), lead({ score: 25 }), lead({ score: 24 })]))
      .toEqual({ hot: 3, warm: 2, cool: 2, noWebsite: 1, failed: 1 });
  });
  it("targets hot leads that only had a quick scan for the full scan", () => {
    const r = [lead({ score: 80, stage: "quick" }), lead({ score: 80, stage: "full" }), lead({ score: 30, stage: "quick" }), lead({ score: null, stage: "quick" })];
    expect(fullScanTargets(r)).toHaveLength(1);
    expect(fullScanButtonText(7)).toMatch(/^Full scan 7 hot leads · \$\d+\.\d\d$/);
    expect(fullScanButtonText(1)).toContain("1 hot lead ·");
  });
});
