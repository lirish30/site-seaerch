import { describe, expect, it } from "vitest";
import { matchMeeting } from "../src/meetily/match.ts";

const at = (hhmm: string) => `2026-11-17T${hhmm}:00.000Z`;
const win = (key: string, from: string, to: string) => ({ key, startAt: at(from), endAt: at(to) });
const meeting = (from: string, to: string) => ({ startedAt: at(from), endedAt: at(to) });

describe("matchMeeting", () => {
  it("matches a meeting inside a window", () => {
    expect(matchMeeting(meeting("10:10", "10:50"), [win("a", "10:00", "11:00")])).toBe("a");
  });

  it("matches a meeting that starts 10 minutes after the window ends, but not 20 minutes after", () => {
    const w = [win("a", "10:00", "11:00")];
    expect(matchMeeting(meeting("11:10", "11:40"), w)).toBe("a");
    expect(matchMeeting(meeting("11:20", "11:50"), w)).toBeNull();
  });

  it("matches a meeting that started a little before the window", () => {
    expect(matchMeeting(meeting("09:50", "10:30"), [win("a", "10:00", "11:00")])).toBe("a");
    expect(matchMeeting(meeting("09:30", "09:40"), [win("a", "10:00", "11:00")])).toBeNull();
  });

  it("picks the window with the larger overlap", () => {
    const ws = [win("short", "10:00", "10:20"), win("long", "10:20", "11:30")];
    expect(matchMeeting(meeting("10:10", "11:10"), ws)).toBe("long");
  });

  it("returns null when two windows overlap the meeting equally", () => {
    expect(matchMeeting(meeting("10:00", "11:00"), [win("a", "10:00", "11:00"), win("b", "10:00", "11:00")])).toBeNull();
  });

  it("returns null with no windows, and honours a tolerance given by the caller", () => {
    expect(matchMeeting(meeting("10:00", "11:00"), [])).toBeNull();
    expect(matchMeeting(meeting("11:10", "11:40"), [win("a", "10:00", "11:00")], 0)).toBeNull();
  });

  it("ignores a window whose times are not dates", () => {
    expect(matchMeeting(meeting("10:00", "11:00"), [{ key: "bad", startAt: "soon", endAt: "later" }, win("a", "10:00", "11:00")])).toBe("a");
  });
});
