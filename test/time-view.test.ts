import { describe, expect, it } from "vitest";
import { dayLabel, elapsedLabel, formatMinutes, parseDuration, shiftDay, varianceLabel, todayIn, weekLabel, weekSummary } from "../src/client/timeView";

describe("formatMinutes", () => {
  it("formatMinutes at 65 and 0", () => {
    expect(formatMinutes(65)).toBe("1h 05m");
    expect(formatMinutes(0)).toBe("0m");
  });
  it("whole hours and under an hour", () => {
    expect(formatMinutes(120)).toBe("2h 00m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(1505)).toBe("25h 05m");
  });
  it("a negative or broken number reads as zero", () => {
    expect(formatMinutes(-5)).toBe("0m");
    expect(formatMinutes(Number.NaN)).toBe("0m");
  });
});

describe("elapsedLabel", () => {
  const start = "2026-11-19T10:00:00.000Z";
  const at = (iso: string) => new Date(iso);
  it("is under a minute at first, then minutes, then hours", () => {
    expect(elapsedLabel(start, at("2026-11-19T10:00:30.000Z"))).toBe("under a minute");
    expect(elapsedLabel(start, at("2026-11-19T10:12:59.000Z"))).toBe("12m");
    expect(elapsedLabel(start, at("2026-11-19T11:05:00.000Z"))).toBe("1h 05m");
  });
  it("elapsedLabel past a day", () => {
    expect(elapsedLabel(start, at("2026-11-20T12:20:00.000Z"))).toBe("1d 2h");
  });
  it("is empty for a start that cannot be read and never goes negative", () => {
    expect(elapsedLabel("nope", at("2026-11-19T10:00:00.000Z"))).toBe("");
    expect(elapsedLabel(start, at("2026-11-19T09:00:00.000Z"))).toBe("under a minute");
  });
});

describe("weekLabel", () => {
  const week = (first: string) => Array.from({ length: 7 }, (_, i) => shiftDay(first, i));
  it("within one month", () => expect(weekLabel(week("2026-11-16"))).toBe("Nov 16 – 22, 2026"));
  it("across months", () => expect(weekLabel(week("2026-11-30"))).toBe("Nov 30 – Dec 6, 2026"));
  it("across a year", () => expect(weekLabel(week("2026-12-28"))).toBe("Dec 28, 2026 – Jan 3, 2027"));
  it("is empty for no days", () => expect(weekLabel([])).toBe(""));
});

describe("shiftDay and dayLabel", () => {
  it("moves by whole days across month ends and back", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-11-16", 7)).toBe("2026-11-23");
    expect(shiftDay("2026-11-16", -7)).toBe("2026-11-09");
  });
  it("labels a day with its weekday", () => {
    expect(dayLabel("2026-11-16")).toEqual({ weekday: "Mon", date: "16" });
    expect(dayLabel("2026-11-22")).toEqual({ weekday: "Sun", date: "22" });
  });
});

describe("varianceLabel", () => {
  it("varianceLabel at 20% over and no estimate", () => {
    expect(varianceLabel(100, 120)).toBe("20% over");
    expect(varianceLabel(0, 50)).toBe("no estimate");
  });
  it("on estimate and under", () => {
    expect(varianceLabel(60, 60)).toBe("on estimate");
    expect(varianceLabel(60, 45)).toBe("25% under");
    expect(varianceLabel(60, 0)).toBe("100% under");
  });
  it("a hair over rounds to on estimate", () => {
    expect(varianceLabel(1000, 1001)).toBe("on estimate");
  });
});

describe("parseDuration", () => {
  it("reads the ways Logan types a time", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration(" 0:45 ")).toBe(45);
  });
  it("refuses nothing, zero, negative and more than a day", () => {
    for (const bad of ["", "abc", "0", "-5", "25h", "1:75", "1.5.5h"]) expect(parseDuration(bad), bad).toBeNull();
  });
});

describe("weekSummary", () => {
  const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
  it("adds up the week: total, days worked, the busiest day and time per project, most first", () => {
    const s = weekSummary({ days, total: 240, dayTotals: [30, 150, 0, 0, 60, 0, 0], rows: [
      { projectId: "a", projectName: "A", total: 60 }, { projectId: "b", projectName: "B", total: 150 }, { projectId: "a", projectName: "A", total: 30 },
    ] });
    expect(s.total).toBe(240);
    expect(s.daysWorked).toBe(3);
    expect(s.busiest).toEqual({ day: "2026-11-17", minutes: 150 });
    expect(s.byProject).toEqual([{ projectId: "b", name: "B", minutes: 150 }, { projectId: "a", name: "A", minutes: 90 }]);
  });
  it("an empty week has no busiest day and no projects", () => {
    const s = weekSummary({ days, total: 0, dayTotals: [0, 0, 0, 0, 0, 0, 0], rows: [] });
    expect(s).toEqual({ total: 0, daysWorked: 0, busiest: null, byProject: [] });
  });
});

describe("todayIn", () => {
  it("is the calendar date in the zone, not in UTC", () => {
    expect(todayIn("America/Los_Angeles", new Date("2026-11-23T05:00:00Z"))).toBe("2026-11-22");
    expect(todayIn("UTC", new Date("2026-11-23T05:00:00Z"))).toBe("2026-11-23");
  });
  it("falls back to the browser's zone for a zone it cannot read", () => {
    expect(todayIn("Not/AZone", new Date("2026-11-23T12:00:00Z"))).toMatch(/^2026-11-2[234]$/);
  });
});
