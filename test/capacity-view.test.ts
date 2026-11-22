import { describe, expect, it } from "vitest";
import { capacityPart, capacityRows, clientsLine, hoursText, stateNote, weekLabel } from "../src/client/capacityView";
import { clientLimitProblem, weeklyHoursProblem } from "../src/client/settingsPagesView";
import type { Capacity } from "../src/worker/capacity/compute";
import { DEFAULT_WORK_CONFIG, WorkConfigSchema } from "../src/worker/time/config";

/** What the worker's schema says about one field's value, or null when it accepts it. */
const schemaSays = (key: "weeklyHoursLimit" | "clientLimit", v: number): string | null => {
  const r = WorkConfigSchema.safeParse({ ...DEFAULT_WORK_CONFIG, [key]: v });
  return r.success ? null : r.error.issues[0].message;
};

describe("capacity view", () => {
  it("the form's messages are the schema's own", () => {
    for (const v of [0, 1, 20, 80, 81, 1.5, -3]) {
      expect(weeklyHoursProblem(String(v)), `weekly ${v}`).toBe(schemaSays("weeklyHoursLimit", v));
    }
    for (const v of [0, 1, 45, 200, 201, 2.5, -1]) {
      expect(clientLimitProblem(String(v)), `clients ${v}`).toBe(schemaSays("clientLimit", v));
    }
    expect(weeklyHoursProblem("")).toBe("Enter hours, like 20.");
    expect(weeklyHoursProblem("abc")).toBe("Enter hours, like 20.");
    expect(clientLimitProblem("")).toBe("Enter a whole number, like 45.");
  });

  it("formats hours, weeks and the clients line", () => {
    expect(hoursText(840)).toBe("14");
    expect(hoursText(90)).toBe("1.5");
    expect(weekLabel("2026-11-30")).toBe("Nov 30");
    expect(clientsLine({ count: 31, limit: 45 })).toEqual({ text: "31 of 45 clients", full: false });
    expect(clientsLine({ count: 45, limit: 45 }).full).toBe(true);
    expect(stateNote("ok")).toBeNull();
    expect(stateNote("near")).toMatch(/nearly full/);
  });

  it("bars cap at the limit and flag a week at or past it", () => {
    const c: Capacity = {
      weeks: [{ monday: "2026-11-30", bookedMinutes: 600, limitMinutes: 1200 }, { monday: "2026-12-07", bookedMinutes: 1500, limitMinutes: 1200 }, { monday: "2026-12-14", bookedMinutes: 0, limitMinutes: 1200 }, { monday: "2026-12-21", bookedMinutes: 0, limitMinutes: 1200 }],
      carryOverMinutes: 0, clients: { count: 1, limit: 45 }, state: "over", sentence: "",
    };
    expect(capacityRows(c).map((r) => [r.label, r.booked, r.pct, r.over])).toEqual([["This week", "10", 50, false], ["Next week", "25", 100, true], ["Week of Dec 14", "0", 0, false], ["Week of Dec 21", "0", 0, false]]);
  });
});

describe("capacityPart", () => {
  const CAP_UNAVAILABLE = "Couldn't work out your booked hours.";
  it("carries the capacity when /today has it, and shows the retry state when it came back null", () => {
    const c = { weeks: [], carryOverMinutes: 0, clients: { count: 0, limit: 45 }, state: "ok", sentence: "x" } as unknown as Capacity;
    expect(capacityPart(c)).toEqual({ data: c, error: "" });
    expect(capacityPart(null)).toEqual({ data: null, error: CAP_UNAVAILABLE });
  });
});
