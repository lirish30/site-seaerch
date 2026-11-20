import { describe, expect, it } from "vitest";
import { dueOnFor, periodKey, periodLabel } from "../src/worker/sop/cadence";

const LA = "America/Los_Angeles";
/** Noon UTC is the same calendar day in Los Angeles, so these dates read the same in both zones. */
const noon = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`);

describe("periodKey", () => {
  it("periodKey at the ISO week boundary around New Year", () => {
    expect(periodKey("weekly", noon("2025-12-28"), LA)).toBe("2025-W52"); // a Sunday
    expect(periodKey("weekly", noon("2025-12-29"), LA)).toBe("2026-W01"); // the Monday of the week that holds 1 January 2026
    expect(periodKey("weekly", noon("2026-01-01"), LA)).toBe("2026-W01");
    expect(periodKey("weekly", noon("2026-12-31"), LA)).toBe("2026-W53");
    expect(periodKey("weekly", noon("2027-01-01"), LA)).toBe("2026-W53"); // a Friday still in the last week of 2026
    expect(periodKey("weekly", noon("2027-01-03"), LA)).toBe("2026-W53");
    expect(periodKey("weekly", noon("2027-01-04"), LA)).toBe("2027-W01");
    expect(periodKey("weekly", noon("2026-11-19"), LA)).toBe("2026-W47");
  });

  it("periodKey for month, quarter and annual", () => {
    expect(periodKey("monthly", noon("2026-11-19"), LA)).toBe("2026-11");
    expect(periodKey("monthly", noon("2026-02-03"), LA)).toBe("2026-02");
    expect(periodKey("quarterly", noon("2026-11-19"), LA)).toBe("2026-Q4");
    expect(periodKey("quarterly", noon("2026-10-01"), LA)).toBe("2026-Q4");
    expect(periodKey("quarterly", noon("2026-09-30"), LA)).toBe("2026-Q3");
    expect(periodKey("annual", noon("2026-11-19"), LA)).toBe("2026");
  });

  it("a date at 23:30 Sunday Pacific is in that Sunday's week", () => {
    const sundayNight = new Date("2026-11-23T07:30:00.000Z"); // Sunday 22 November, 23:30 in Los Angeles; Monday 23 November in UTC
    expect(periodKey("weekly", sundayNight, LA)).toBe("2026-W47");
    expect(periodKey("weekly", sundayNight, "UTC")).toBe("2026-W48");
    expect(periodKey("monthly", new Date("2026-12-01T07:30:00.000Z"), LA)).toBe("2026-11"); // 23:30 on 30 November there
    expect(dueOnFor("weekly", 3, sundayNight, LA)).toBe("2026-11-18");
  });
});

describe("dueOnFor", () => {
  it("dueOnFor weekly day 3 is the Wednesday of that week in the zone", () => {
    expect(dueOnFor("weekly", 3, noon("2026-11-19"), LA)).toBe("2026-11-18"); // a Thursday: that week's Wednesday has passed
    expect(dueOnFor("weekly", 3, noon("2026-11-16"), LA)).toBe("2026-11-18");
    expect(dueOnFor("weekly", 1, noon("2026-11-19"), LA)).toBe("2026-11-16");
    expect(dueOnFor("weekly", 7, noon("2026-11-19"), LA)).toBe("2026-11-22");
    expect(dueOnFor("weekly", null, noon("2026-11-19"), LA)).toBe("2026-11-22"); // the last day of the week
    expect(dueOnFor("weekly", 3, noon("2027-01-01"), LA)).toBe("2026-12-30"); // across the year end
  });

  it("dueOnFor monthly day 5", () => {
    expect(dueOnFor("monthly", 5, noon("2026-11-19"), LA)).toBe("2026-11-05");
    expect(dueOnFor("monthly", 28, noon("2027-02-10"), LA)).toBe("2027-02-28");
    expect(dueOnFor("monthly", null, noon("2026-11-19"), LA)).toBe("2026-11-30");
    expect(dueOnFor("monthly", null, noon("2028-02-10"), LA)).toBe("2028-02-29");
  });

  it("dueOnFor a quarter or a year: the day falls in the first month, and no day gives the last day of the period", () => {
    expect(dueOnFor("quarterly", 5, noon("2026-11-19"), LA)).toBe("2026-10-05");
    expect(dueOnFor("quarterly", null, noon("2026-11-19"), LA)).toBe("2026-12-31");
    expect(dueOnFor("quarterly", null, noon("2026-02-19"), LA)).toBe("2026-03-31");
    expect(dueOnFor("annual", 5, noon("2026-11-19"), LA)).toBe("2026-01-05");
    expect(dueOnFor("annual", null, noon("2026-11-19"), LA)).toBe("2026-12-31");
  });
});

describe("periodLabel", () => {
  it("reads like a person would say it", () => {
    expect(periodLabel("weekly", "2026-W48")).toBe("Week of Nov 23");
    expect(periodLabel("weekly", "2026-W53")).toBe("Week of Dec 28");
    expect(periodLabel("weekly", "2027-W01")).toBe("Week of Jan 4");
    expect(periodLabel("weekly", "2026-W01")).toBe("Week of Dec 29"); // the week starts in the old year
    expect(periodLabel("monthly", "2026-11")).toBe("November 2026");
    expect(periodLabel("quarterly", "2026-Q4")).toBe("Q4 2026");
    expect(periodLabel("annual", "2026")).toBe("2026");
  });
  it("a key it cannot read comes back as it is", () => {
    expect(periodLabel("weekly", "nonsense")).toBe("nonsense");
    expect(periodLabel("monthly", "2026-13")).toBe("2026-13");
  });
});
