import { describe, expect, it } from "vitest";
import { fieldErrors, parseJobValue, parseTowns, runSearchesLines, stepLabel } from "../src/client/campaignView";

describe("stepLabel", () => {
  it("names the kind and counts business or calendar days", () => {
    expect(stepLabel({ kind: "email", offset_days: 5, offset_kind: "business" })).toBe("Email · business day 5");
    expect(stepLabel({ kind: "call", offset_days: 7, offset_kind: "calendar" })).toBe("Call · day 7");
    expect(stepLabel({ kind: "checkin", offset_days: 90, offset_kind: "calendar" })).toBe("Check-in · day 90");
  });
  it("labels the first email as day 0", () => {
    expect(stepLabel({ kind: "email", offset_days: 0, offset_kind: "business" })).toBe("Email · business day 0");
  });
});

describe("parseTowns", () => {
  it("splits on commas and new lines, trims and drops blanks", () => {
    expect(parseTowns("Napa, Sonoma\nVallejo,, \n  Fairfield  ")).toEqual(["Napa", "Sonoma", "Vallejo", "Fairfield"]);
  });
  it("collapses case-insensitive duplicates to the first spelling", () => {
    expect(parseTowns("Napa\nnapa, NAPA, Sonoma")).toEqual(["Napa", "Sonoma"]);
  });
  it("is empty for nothing", () => expect(parseTowns("  \n , ")).toEqual([]));
});

describe("parseJobValue", () => {
  it("reads blank as no value and a non-negative number as that number", () => {
    expect(parseJobValue("")).toEqual({ ok: true, value: null });
    expect(parseJobValue("  ")).toEqual({ ok: true, value: null });
    expect(parseJobValue("2500")).toEqual({ ok: true, value: 2500 });
    expect(parseJobValue("$1,200.50")).toEqual({ ok: true, value: 1200.5 });
    expect(parseJobValue("0")).toEqual({ ok: true, value: 0 });
  });
  it("refuses anything else", () => {
    for (const bad of ["abc", "-5", "12x", "1e3x"]) expect(parseJobValue(bad), bad).toEqual({ ok: false });
  });
});

describe("fieldErrors", () => {
  it("takes the first message per field from the server's 400", () => {
    expect(fieldErrors({ name: ["Too small"], towns: ["Too big", "x"] })).toEqual({ name: "Too small", towns: "Too big" });
  });
  it("ignores anything that is not a field map", () => {
    expect(fieldErrors([])).toEqual({});
    expect(fieldErrors(undefined)).toEqual({});
    expect(fieldErrors({ a: [], b: "oops", c: [1] })).toEqual({});
  });
});

describe("runSearchesLines", () => {
  it("says how many started and lists each blocked town with its reason", () => {
    expect(runSearchesLines({ started: 3, blocked: [] })).toEqual(["Started 3 searches."]);
    expect(runSearchesLines({ started: 1, blocked: [{ town: "Napa", reason: "Monthly spend limit reached" }] }))
      .toEqual(["Started 1 search.", "Napa: blocked. Monthly spend limit reached"]);
    expect(runSearchesLines({ started: 0, blocked: [{ town: "A", reason: "x" }, { town: "B", reason: "y" }] }))
      .toEqual(["Started 0 searches.", "A: blocked. x", "B: blocked. y"]);
  });
});
