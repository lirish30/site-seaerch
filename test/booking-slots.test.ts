import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type BookingConfig } from "../src/worker/booking/config";
import { computeSlots, isOffered, suggestTwo } from "../src/worker/booking/slots";

const LA = "America/Los_Angeles";
const cfg = (over: Partial<BookingConfig>): BookingConfig => ({ ...DEFAULT_CONFIG, ...over });
const at = (iso: string) => new Date(iso);
const busy = (start: string, end: string) => ({ start: Date.parse(start), end: Date.parse(end) });
/** Tuesday 09:00-10:00 in Los Angeles. 2026-11-24 is a Tuesday; 09:00 PST is 17:00Z. */
const TUE_9_10 = cfg({ windows: [{ weekday: 2, start: "09:00", end: "10:00" }], horizonDays: 7 });
const MON_MIDNIGHT_PST = at("2026-11-23T08:00:00.000Z");

describe("computeSlots", () => {
  it("offers only starts whose full call fits inside a window", () => {
    // 20-minute calls on a 20-minute step: 09:00, 09:20, 09:40 (ends 10:00). 10:00 would run past the window.
    expect(computeSlots(TUE_9_10, "discovery", [], MON_MIDNIGHT_PST)).toEqual([
      "2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-24T17:40:00.000Z",
    ]);
  });

  it("a 30-minute recommendation slot is refused where a 20-minute one fits", () => {
    expect(computeSlots(TUE_9_10, "discovery", [], MON_MIDNIGHT_PST)).toContain("2026-11-24T17:40:00.000Z");
    // 09:40 + 30 minutes ends 10:10, past the window.
    expect(computeSlots(TUE_9_10, "recommendation", [], MON_MIDNIGHT_PST)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z"]);
    expect(isOffered(TUE_9_10, "discovery", [], MON_MIDNIGHT_PST, "2026-11-24T17:40:00.000Z")).toBe(true);
    expect(isOffered(TUE_9_10, "recommendation", [], MON_MIDNIGHT_PST, "2026-11-24T17:40:00.000Z")).toBe(false);
    expect(isOffered(TUE_9_10, "discovery", [], MON_MIDNIGHT_PST, "2026-11-24T17:05:00.000Z")).toBe(false);
    expect(isOffered(TUE_9_10, "discovery", [], MON_MIDNIGHT_PST, "garbage")).toBe(false);
  });

  it("respects the minimum notice", () => {
    const c = { ...TUE_9_10, minNoticeHours: 1 };
    // Now is 08:30 PST on the Tuesday: earliest start is 09:30, so only 09:40 is left.
    expect(computeSlots(c, "discovery", [], at("2026-11-24T16:30:00.000Z"))).toEqual(["2026-11-24T17:40:00.000Z"]);
    // Exactly the notice away is allowed: now 08:00 PST, 09:00 is one hour out.
    expect(computeSlots(c, "discovery", [], at("2026-11-24T16:00:00.000Z"))).toHaveLength(3);
    expect(computeSlots({ ...c, minNoticeHours: 2 }, "discovery", [], at("2026-11-24T16:00:00.000Z"))).toEqual([]);
  });

  it("stops at the horizon", () => {
    const c = cfg({ windows: [{ weekday: 2, start: "09:00", end: "09:20" }, { weekday: 3, start: "09:00", end: "09:20" }], minNoticeHours: 1 });
    expect(computeSlots({ ...c, horizonDays: 1 }, "discovery", [], MON_MIDNIGHT_PST)).toEqual([]);
    expect(computeSlots({ ...c, horizonDays: 2 }, "discovery", [], MON_MIDNIGHT_PST)).toEqual(["2026-11-24T17:00:00.000Z"]);
    expect(computeSlots({ ...c, horizonDays: 3 }, "discovery", [], MON_MIDNIGHT_PST)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-25T17:00:00.000Z"]);
    // A start exactly horizonDays out is still offered.
    expect(computeSlots({ ...c, horizonDays: 1 }, "discovery", [], at("2026-11-23T17:00:00.000Z"))).toEqual(["2026-11-24T17:00:00.000Z"]);
  });

  it("a busy interval removes slots within the buffer on both sides", () => {
    const c = cfg({ windows: [{ weekday: 2, start: "09:00", end: "11:00" }], horizonDays: 7, bufferMin: 10 });
    expect(computeSlots(c, "discovery", [], MON_MIDNIGHT_PST)).toEqual([
      "2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-24T17:40:00.000Z",
      "2026-11-24T18:00:00.000Z", "2026-11-24T18:20:00.000Z", "2026-11-24T18:40:00.000Z",
    ]);
    // Busy 09:40-10:00. 09:00 (ends 09:20, +10 min buffer = 09:30) is clear; 09:20 ends 09:40 and its buffer touches the meeting;
    // 09:40 is inside it; 10:00 starts when it ends, inside the buffer; 10:20 is the first start 20 minutes clear.
    const b = [busy("2026-11-24T17:40:00.000Z", "2026-11-24T18:00:00.000Z")];
    expect(computeSlots(c, "discovery", b, MON_MIDNIGHT_PST)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T18:20:00.000Z", "2026-11-24T18:40:00.000Z"]);
    // With no buffer, back-to-back is fine.
    expect(computeSlots({ ...c, bufferMin: 0 }, "discovery", b, MON_MIDNIGHT_PST)).toEqual([
      "2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-24T18:00:00.000Z", "2026-11-24T18:20:00.000Z", "2026-11-24T18:40:00.000Z",
    ]);
  });

  it("no slot is offered inside the spring-forward gap", () => {
    // 2027-03-14 is a Sunday. Clocks jump from 02:00 PST to 03:00 PDT, so 02:00-02:59 does not exist.
    const c = cfg({ windows: [{ weekday: 0, start: "01:30", end: "04:00" }], horizonDays: 7, minNoticeHours: 1 });
    expect(computeSlots(c, "discovery", [], at("2027-03-10T00:00:00.000Z"))).toEqual([
      "2027-03-14T09:30:00.000Z", // 01:30 PST
      "2027-03-14T09:50:00.000Z", // 01:50 PST
      "2027-03-14T10:10:00.000Z", // 03:10 PDT (02:10, 02:30 and 02:50 do not exist)
      "2027-03-14T10:30:00.000Z", // 03:30 PDT
    ]); // 03:50 PDT would end at 04:10, past the window
  });

  it("fall-back day offers each wall-clock time once", () => {
    // 2026-11-01 is a Sunday. At 02:00 PDT clocks return to 01:00 PST, so 01:00-01:59 happens twice. The first (PDT) occurrence is offered.
    const c = cfg({ windows: [{ weekday: 0, start: "00:00", end: "03:00" }], slotStepMin: 30, horizonDays: 7, minNoticeHours: 1 });
    expect(computeSlots(c, "discovery", [], at("2026-10-30T00:00:00.000Z"))).toEqual([
      "2026-11-01T07:00:00.000Z", // 00:00 PDT
      "2026-11-01T07:30:00.000Z", // 00:30 PDT
      "2026-11-01T08:00:00.000Z", // 01:00 PDT
      "2026-11-01T08:30:00.000Z", // 01:30 PDT
      "2026-11-01T10:00:00.000Z", // 02:00 PST
      "2026-11-01T10:30:00.000Z", // 02:30 PST
    ]);
  });

  it("no windows means no slots", () => {
    expect(computeSlots(DEFAULT_CONFIG, "discovery", [], MON_MIDNIGHT_PST)).toEqual([]);
    expect(computeSlots(cfg({ windows: [] }), "recommendation", [], MON_MIDNIGHT_PST)).toEqual([]);
  });

  it("overlapping windows offer a start once, in ascending order", () => {
    const c = cfg({ windows: [{ weekday: 2, start: "09:20", end: "10:00" }, { weekday: 2, start: "09:00", end: "09:40" }], horizonDays: 7 });
    expect(computeSlots(c, "discovery", [], MON_MIDNIGHT_PST)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-24T17:40:00.000Z"]);
  });

  it("works in another time zone", () => {
    // Tuesday 09:00-09:20 in New York (EST, UTC-5) is 14:00Z.
    const c = cfg({ timezone: "America/New_York", windows: [{ weekday: 2, start: "09:00", end: "09:20" }], horizonDays: 7 });
    expect(computeSlots(c, "discovery", [], at("2026-11-23T05:00:00.000Z"))).toEqual(["2026-11-24T14:00:00.000Z"]);
  });
});

describe("suggestTwo", () => {
  it("picks different days", () => {
    const slots = ["2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-25T17:00:00.000Z", "2026-11-26T17:00:00.000Z"];
    expect(suggestTwo(slots, LA)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-25T17:00:00.000Z"]);
    // 03:00Z and 04:00Z on the 25th are both the evening of the 24th in Los Angeles: the same local day.
    expect(suggestTwo(["2026-11-25T03:00:00.000Z", "2026-11-25T04:00:00.000Z", "2026-11-25T17:00:00.000Z"], LA)).toEqual(["2026-11-25T03:00:00.000Z", "2026-11-25T17:00:00.000Z"]);
  });

  it("falls back to the next slot when everything is on one day, and returns fewer when fewer exist", () => {
    expect(suggestTwo(["2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z", "2026-11-24T17:40:00.000Z"], LA)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T17:20:00.000Z"]);
    expect(suggestTwo(["2026-11-24T17:00:00.000Z"], LA)).toEqual(["2026-11-24T17:00:00.000Z"]);
    expect(suggestTwo([], LA)).toEqual([]);
  });
});
