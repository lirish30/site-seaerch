import { describe, expect, it } from "vitest";
import { VIDEO_EMAIL_LABEL, videoEmailHelp, fieldErrors, parseJobValue, parseTowns, runResultTone, runSearchesConfirm, runSearchesLines, stepLabel, campaignStats, townsLine } from "../src/client/campaignView";

describe("campaign stats", () => {
  it("counts the leads and the towns its own searches covered", () => {
    const s = campaignStats({ id: "c1", towns: ["Tigard", "Sherwood", "Tualatin"] }, [
      { campaign_id: "c1", location: "tigard", found_count: 10, status: "done", created_at: "2026-11-01" },
      { campaign_id: "c1", location: "Sherwood", found_count: 5, status: "running", created_at: "2026-11-02" },
      { campaign_id: "c2", location: "Tualatin", found_count: 99, status: "done", created_at: "2026-11-03" },
    ]);
    expect(s).toEqual({ leads: 15, searchedTowns: 2, running: true, lastRunAt: "2026-11-02" });
  });
  it("shortens a long town list", () => {
    expect(townsLine(["A", "B", "C", "D"])).toBe("A, B +2");
    expect(townsLine(["A"])).toBe("A");
  });
});

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

describe("runSearchesConfirm", () => {
  it("states how many searches will start, singular and plural", () => {
    expect(runSearchesConfirm(1)).toBe("This will start 1 search (one per town) and uses your lead-data budget. Continue?");
    expect(runSearchesConfirm(3)).toBe("This will start 3 searches (one per town) and uses your lead-data budget. Continue?");
  });
});

describe("runResultTone", () => {
  it("is ok when nothing was blocked, warn on a partial block, bad when nothing started", () => {
    expect(runResultTone({ started: 3, blocked: [] })).toBe("ok");
    expect(runResultTone({ started: 2, blocked: [{ town: "A" }] })).toBe("warn");
    expect(runResultTone({ started: 0, blocked: [{ town: "A" }, { town: "B" }] })).toBe("bad");
  });
});

describe("video email switch", () => {
  it("is labelled in the owner's words", () => {
    expect(VIDEO_EMAIL_LABEL).toBe("Email 1 carries the video audit (needs a published video)");
  });
  it("says what Start does only while it is on", () => {
    expect(videoEmailHelp(0)).toBe("");
    expect(videoEmailHelp(1)).toContain("published video");
    expect(videoEmailHelp(1)).toContain("Email 1");
  });
});
