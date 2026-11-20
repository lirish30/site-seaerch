import { describe, expect, it } from "vitest";
import { addDays, addMonths, calendarDateIn, calendarDaysBetween } from "../src/worker/billing/dates";

describe("billing dates", () => {
  it("addMonths clamps 31 Jan to 28 Feb and 29 Feb in a leap year", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2027-03-31", 1)).toBe("2027-04-30");
    expect(addMonths("2027-12-15", 1)).toBe("2028-01-15");
    expect(addMonths("2027-01-15", -2)).toBe("2026-11-15");
  });

  it("addMonths from 31 Jan by 24 lands on 31 Jan", () => {
    expect(addMonths("2027-01-31", 24)).toBe("2029-01-31");
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
  });

  it("calendarDaysBetween across a month and a DST change counts whole days", () => {
    expect(calendarDaysBetween("2027-01-30", "2027-02-02")).toBe(3);
    expect(calendarDaysBetween("2027-03-13", "2027-03-15")).toBe(2); // US clocks went forward on 14 March 2027
    expect(calendarDaysBetween("2027-11-06", "2027-11-08")).toBe(2); // and back on 7 November
    expect(calendarDaysBetween("2027-05-05", "2027-05-01")).toBe(-4);
    expect(calendarDaysBetween("2027-05-05", "2027-05-05")).toBe(0);
  });

  it("addDays moves across month and year ends", () => {
    expect(addDays("2027-12-30", 3)).toBe("2028-01-02");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("calendarDateIn gives the Pacific date at 23:30 on the 31st", () => {
    // 23:30 PST on 31 Dec 2026 is 07:30 UTC on 1 Jan 2027.
    expect(calendarDateIn(new Date("2027-01-01T07:30:00.000Z"), "America/Los_Angeles")).toBe("2026-12-31");
    expect(calendarDateIn(new Date("2027-01-01T07:30:00.000Z"), "UTC")).toBe("2027-01-01");
    // 23:30 PDT on 31 Aug is 06:30 UTC on 1 Sep.
    expect(calendarDateIn(new Date("2027-09-01T06:30:00.000Z"), "America/Los_Angeles")).toBe("2027-08-31");
  });
});
