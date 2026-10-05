import { describe, expect, it } from "vitest";
import { elapsedSeconds, estimateRemainingSeconds, formatClock, formatEta, searchStage } from "../src/client/eta";
import type { Search } from "../src/client/types";

const T0 = Date.parse("2026-10-03T12:00:00.000Z");
const s = (o: Partial<Search>): Search => ({ id: "s", location: "L", business_type: "b", max_results: 50, status: "running",
  error: null, found_count: 0, processed_count: 0, created_at: "2026-10-03T12:00:00.000Z", new_only: 0, quick_scan: 0, ...o });

describe("searchStage", () => {
  it("is fetching until listings are found, then auditing, then done", () => {
    expect(searchStage(s({}))).toBe("fetching");
    expect(searchStage(s({ found_count: 20, processed_count: 4 }))).toBe("auditing");
    expect(searchStage(s({ status: "done", found_count: 20, processed_count: 8 }))).toBe("auditing");
    expect(searchStage(s({ status: "done", found_count: 20, processed_count: 20 }))).toBe("done");
    expect(searchStage(s({ status: "done", found_count: 0, processed_count: 0 }))).toBe("done");
    expect(searchStage(s({ status: "failed" }))).toBe("failed");
  });
});

describe("estimateRemainingSeconds", () => {
  it("estimates fetch + audit time up front from max results", () => {
    // 50 results → 10 batches
    const eta = estimateRemainingSeconds(s({}), T0)!;
    expect(eta).toBeGreaterThan(60 + 9 * 20);
  });
  it("never claims zero while the listings fetch is still running", () => {
    expect(estimateRemainingSeconds(s({}), T0 + 10 * 60_000)!).toBeGreaterThan(0);
  });
  it("counts down the audit batches that are left", () => {
    const early = estimateRemainingSeconds(s({ found_count: 20, processed_count: 0 }), T0 + 60_000)!;
    const late = estimateRemainingSeconds(s({ found_count: 20, processed_count: 15 }), T0 + 60_000)!;
    expect(late).toBeLessThan(early);
  });
  it("switches to the measured pace once enough leads are done", () => {
    // 10 leads took 100s after the fetch estimate → 10s/lead, 10 left → 100s
    const eta = estimateRemainingSeconds(s({ found_count: 20, processed_count: 10 }), T0 + (60 + 100) * 1000)!;
    expect(eta).toBe(100);
  });
  it("is null when the search is finished or failed", () => {
    expect(estimateRemainingSeconds(s({ status: "failed" }), T0)).toBeNull();
    expect(estimateRemainingSeconds(s({ status: "done", found_count: 5, processed_count: 5 }), T0)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats elapsed time as m:ss and clamps negatives", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(-5)).toBe("0:00");
    expect(elapsedSeconds("2026-10-03T12:00:00.000Z", T0 + 90_000)).toBe(90);
  });
  it("formats the ETA as a rounded, approximate duration", () => {
    expect(formatEta(20)).toBe("under a minute");
    expect(formatEta(95)).toBe("about 2 min");
    expect(formatEta(600)).toBe("about 10 min");
  });
});
