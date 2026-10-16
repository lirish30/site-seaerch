import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import {
  blockedText, cap, checkTimeText, createBody, foundText, formFromRadar, formProblem, intervalChoices, intervalLabel, lastRunText, marketName,
  monthlyLimitText, NEW_FORM, nextRunText, patchBody, resultChoices, saveErrorText, usedText,
} from "../src/client/radarView";
import type { Radar } from "../src/client/types";

const NOW = new Date("2026-10-03T12:00:00Z").getTime();
const at = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const radar = (o: Partial<Radar> = {}): Radar => ({
  id: "r1", location: "Boise, ID", business_type: "roofer", radius_km: 15, max_results: 50, interval_days: 30, enabled: 1, next_run_at: at(2), last_run_at: at(-28),
  last_search_id: "s1", last_error: null, created_at: at(-60), newLeadCount: 6, lastSearchStatus: "done", ...o,
});

describe("labels", () => {
  it("names the market and capitalises the first letter only", () => {
    expect(marketName(radar())).toBe("Roofer in Boise, ID");
    expect(marketName(radar({ business_type: "HVAC", location: "Nampa, ID" }))).toBe("HVAC in Nampa, ID");
    expect(cap("")).toBe("");
    expect(intervalLabel(14)).toBe("Every 14 days");
  });
  it("words the check time, the limit and the usage line", () => {
    expect(checkTimeText({ hour: 13, minute: 17 })).toBe("1:17 pm UTC");
    expect(checkTimeText({ hour: 0, minute: 5 })).toBe("12:05 am UTC");
    expect(checkTimeText({ hour: 12, minute: 0 })).toBe("12:00 pm UTC");
    expect(monthlyLimitText(150)).toBe("$150");
    expect(monthlyLimitText(25.5)).toBe("$25.50");
    expect(usedText(4, 20)).toBe("4 of 20 radars used");
  });
  it("offers the standard intervals plus an odd stored one, and the standard result sizes plus an odd one", () => {
    expect(intervalChoices(30)).toEqual([7, 14, 30, 60, 90]);
    expect(intervalChoices(21)).toEqual([7, 14, 21, 30, 60, 90]);
    expect(resultChoices(50)).toEqual([25, 50, 100, 200]);
    expect(resultChoices(75)).toEqual([25, 50, 75, 100, 200]);
  });
});

describe("row text", () => {
  it("says when it runs next and last, and Paused for a radar that is off", () => {
    expect(nextRunText(radar(), NOW)).toBe("In 2 days");
    expect(nextRunText(radar({ next_run_at: at(1) }), NOW)).toBe("Tomorrow");
    expect(nextRunText(radar({ enabled: 0 }), NOW)).toBe("Paused");
    expect(lastRunText(radar(), NOW)).toBe("28 days ago");
    expect(lastRunText(radar({ last_run_at: at(0) }), NOW)).toBe("Today");
    expect(lastRunText(radar({ last_run_at: null }), NOW)).toBe("Never");
  });
  it("links the last search with its new-lead count, and says so far while it runs", () => {
    expect(foundText(radar())).toEqual({ text: "6 new leads", searchId: "s1" });
    expect(foundText(radar({ newLeadCount: 1 }))?.text).toBe("1 new lead");
    expect(foundText(radar({ newLeadCount: 0 }))?.text).toBe("0 new leads");
    expect(foundText(radar({ lastSearchStatus: "running", newLeadCount: 3 }))?.text).toBe("3 new leads so far");
    expect(foundText(radar({ last_search_id: null }))).toBeNull();
  });
  it("explains a blocked radar and when it tries again", () => {
    expect(blockedText(radar(), NOW)).toBeNull();
    expect(blockedText(radar({ last_error: "Spend limit: $150.00 spent of $150.00 this month", next_run_at: at(1) }), NOW)).toBe("Blocked by spend limit · retries tomorrow");
    expect(blockedText(radar({ last_error: "boom", next_run_at: at(0) }), NOW)).toBe("Couldn't start: boom · retries today");
    expect(blockedText(radar({ last_error: "spend limit hit", next_run_at: at(12) }), NOW)).toBe("Blocked by spend limit · next try in 12 days");
    expect(blockedText(radar({ last_error: "x".repeat(200), next_run_at: at(1) }), NOW)!.length).toBeLessThan(120);
  });
});

describe("radar form", () => {
  it("validates a new radar and an edit", () => {
    expect(formProblem(NEW_FORM, false)).toMatch(/kind of business/);
    expect(formProblem({ ...NEW_FORM, businessType: "plumber" }, false)).toMatch(/where/i);
    expect(formProblem({ ...NEW_FORM, businessType: "plumber", location: "Boise, ID" }, false)).toBeNull();
    expect(formProblem({ ...NEW_FORM, businessType: "plumber", location: "Boise", maxResults: 201 }, false)).toMatch(/1 to 200/);
    expect(formProblem({ ...NEW_FORM, businessType: "plumber", location: "Boise", maxResults: 1.5 }, false)).toMatch(/whole number/);
    expect(formProblem({ ...NEW_FORM, businessType: "plumber", location: "Boise", radiusKm: 0 }, false)).toMatch(/radius/);
    expect(formProblem({ ...NEW_FORM, maxResults: 50 }, true)).toBeNull(); // editing never re-checks the market it cannot change
  });
  it("builds the create body trimmed, and the patch with only what changed", () => {
    expect(createBody({ ...NEW_FORM, businessType: " plumber ", location: " Boise, ID ", runNow: true }))
      .toEqual({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 50, intervalDays: 30, runNow: true });
    const r = radar();
    expect(patchBody(formFromRadar(r), r)).toEqual({});
    expect(patchBody({ ...formFromRadar(r), maxResults: 100, intervalDays: 7 }, r)).toEqual({ intervalDays: 7, maxResults: 100 });
    expect(patchBody({ ...formFromRadar(r), radiusKm: 30 }, r)).toEqual({ radiusKm: 30 });
    expect(formFromRadar(radar({ radius_km: undefined })).radiusKm).toBe(15);
  });
  it("words a failed save: 402 as the spend limit, other API errors as they are, anything else generically", () => {
    expect(saveErrorText(new ApiError(402, "x"))).toMatch(/monthly spend limit/);
    expect(saveErrorText(new ApiError(409, "a radar for this location and business type already exists"))).toBe("a radar for this location and business type already exists");
    expect(saveErrorText(new Error("net"))).toBe("Couldn't save the radar.");
  });
});
