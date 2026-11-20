import { describe, expect, it } from "vitest";
import { dayLabel, elapsedLabel, formatMinutes, parseDuration, shiftDay, varianceLabel, weekLabel } from "../src/client/timeView";

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
