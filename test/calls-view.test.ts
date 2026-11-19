import { describe, expect, it } from "vitest";
import { callWhen, upcomingCalls } from "../src/client/callsView";

const call = (id: string, startAt: string) => ({ id, startAt });
// Wednesday 18 Nov 2026, 10:00 in Los Angeles (PST, UTC-8).
const NOW = new Date("2026-11-18T18:00:00.000Z");

describe("upcomingCalls", () => {
  it("upcomingCalls labels today and tomorrow in Pacific time", () => {
    const out = upcomingCalls([
      call("later", "2026-11-23T18:00:00.000Z"),
      call("tomorrow", "2026-11-19T17:00:00.000Z"),
      call("today", "2026-11-18T23:00:00.000Z"),
      // 22:00 Pacific tonight is already 06:00 UTC tomorrow: still "today" for Logan.
      call("tonight", "2026-11-19T06:00:00.000Z"),
      // 00:30 Pacific tomorrow is 08:30 UTC.
      call("tomorrow-early", "2026-11-19T08:30:00.000Z"),
    ], NOW);
    expect(out.map((c) => [c.booking.id, c.label])).toEqual([
      ["today", "today"], ["tonight", "today"], ["tomorrow-early", "tomorrow"], ["tomorrow", "tomorrow"], ["later", "later"],
    ]);
  });

  it("keeps the next 7 days, soonest first, and drops what has started or is further out", () => {
    const out = upcomingCalls([
      call("past", "2026-11-18T17:59:00.000Z"), call("edge", "2026-11-25T18:00:00.000Z"), call("in", "2026-11-25T17:59:00.000Z"), call("now", "2026-11-18T18:00:00.000Z"),
    ], NOW);
    expect(out.map((c) => c.booking.id)).toEqual(["now", "in"]);
  });

  it("tomorrow is the next calendar day in Pacific time, also across the spring change", () => {
    // 23:30 Pacific on Sat 13 Mar 2027 (PST); the clocks go forward in the night.
    const now = new Date("2027-03-14T07:30:00.000Z");
    const out = upcomingCalls([call("last-minute", "2027-03-15T06:59:00.000Z"), call("after", "2027-03-15T07:00:00.000Z")], now);
    expect(out.map((c) => [c.booking.id, c.label])).toEqual([["last-minute", "tomorrow"], ["after", "later"]]);
  });
});

describe("callWhen", () => {
  it("names the day for today and tomorrow and the date for later, with the zone", () => {
    expect(callWhen("2026-11-18T23:00:00.000Z", "today")).toBe("Today, 3:00 PM PST");
    expect(callWhen("2026-11-19T17:00:00.000Z", "tomorrow")).toBe("Tomorrow, 9:00 AM PST");
    expect(callWhen("2026-11-23T18:00:00.000Z", "later")).toBe("Mon, Nov 23, 10:00 AM PST");
  });
});
