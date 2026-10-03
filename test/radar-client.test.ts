import { describe, expect, it } from "vitest";
import { radarBodyFor, radarFollowUpNotice, relativeDay, startErrorText, RADAR_INTERVALS } from "../src/client/radar";

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
  it("words the follow-up notice for duplicates and other failures", () => {
    expect(radarFollowUpNotice(409, "a radar for this location and business type already exists")).toMatch(/already exists/);
    expect(radarFollowUpNotice(500, "")).toMatch(/unexpected error/);
  });
  it("offers 7/14/30/60/90 day intervals within the API's 7-90 range", () => {
    expect(RADAR_INTERVALS.every((d) => d >= 7 && d <= 90)).toBe(true);
    expect(RADAR_INTERVALS).toContain(30);
  });
});
