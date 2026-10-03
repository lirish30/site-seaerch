import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { actionErrorText, radarBodyFor, radarFollowUpNotice, radarLabel, relativeDay, runConfirmText, startErrorText } from "../src/client/radar";

const NOW = new Date("2026-10-03T12:00:00Z").getTime();
const at = (days: number) => new Date(NOW + days * 86400000).toISOString();

describe("relativeDay", () => {
  it("describes past and future dates in whole days", () => {
    expect(relativeDay(at(0), NOW)).toBe("today");
    expect(relativeDay(at(1), NOW)).toBe("tomorrow");
    expect(relativeDay(at(-1), NOW)).toBe("yesterday");
    expect(relativeDay(at(12), NOW)).toBe("in 12 days");
    expect(relativeDay(at(-9), NOW)).toBe("9 days ago");
  });
  it("says never for null or garbage", () => {
    expect(relativeDay(null, NOW)).toBe("never");
    expect(relativeDay("nope", NOW)).toBe("never");
  });
});

describe("radar helpers", () => {
  it("maps 402 to the spend-limit text and passes other errors through", () => {
    expect(startErrorText(402, "spend limit")).toMatch(/monthly spend limit/);
    expect(startErrorText(400, "Fill in your physical address")).toBe("Fill in your physical address");
  });
  it("builds a radar body that does not run immediately", () => {
    expect(radarBodyFor({ location: "Boise", businessType: "plumber", radiusKm: 15, maxResults: 50 }, 30))
      .toEqual({ location: "Boise", businessType: "plumber", radiusKm: 15, maxResults: 50, intervalDays: 30, runNow: false });
  });
  it("words the follow-up notice for a duplicate and for an empty error", () => {
    expect(radarFollowUpNotice("a radar for this location and business type already exists")).toBe(
      "Search started, but the Radar wasn't saved: a radar for this location and business type already exists.");
    expect(radarFollowUpNotice("")).toMatch(/unexpected error/);
  });
  it("shows the cost, the market and per-row labels before spending", () => {
    const r = { business_type: "plumber", location: "Boise" };
    expect(runConfirmText(0.0515, r)).toBe("Run this search now? plumber in Boise. Estimated cost about $0.05.");
    expect(radarLabel("Run now", r)).toBe("Run now for plumber in Boise");
    expect(radarLabel("Delete", r)).not.toBe(radarLabel("Delete", { ...r, location: "Reno" }));
  });
  it("words action errors: spend limit, API message, or a generic fallback", () => {
    expect(actionErrorText(new ApiError(402, "spend limit"))).toMatch(/monthly spend limit/);
    expect(actionErrorText(new ApiError(409, "this radar just ran"))).toBe("this radar just ran");
    expect(actionErrorText(new TypeError("network"))).toBe("Failed");
  });
});
