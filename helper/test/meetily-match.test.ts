import { describe, expect, it } from "vitest";
import { matchMeeting } from "../src/meetily/match.ts";

const at = (hhmm: string) => `2026-11-17T${hhmm}:00.000Z`;
const win = (key: string, from: string, to: string) => ({ key, startAt: at(from), endAt: at(to) });
const meeting = (from: string, to: string) => ({ startedAt: at(from), endedAt: at(to) });

describe("matchMeeting", () => {
  it("matches a meeting inside a window", () => {
    expect(matchMeeting(meeting("10:10", "10:50"), [win("a", "10:00", "11:00")])).toBe("a");
  });

  it("does not match a recording that ends exactly when the booked call starts, or starts exactly when it ends", () => {
    const w = [win("client", "10:00", "10:30")];
    expect(matchMeeting(meeting("09:30", "10:00"), w)).toBeNull(); // the Webfor stand-up just before
    expect(matchMeeting(meeting("10:30", "11:00"), w)).toBeNull(); // the one just after
  });

  it("does not match a neighbouring recording that starts 10 minutes after the window ends, or one that runs 10 minutes into it from before", () => {
    const w = [win("a", "10:00", "11:00")];
    expect(matchMeeting(meeting("11:10", "11:40"), w)).toBeNull();
    expect(matchMeeting(meeting("09:20", "10:10"), w)).toBeNull(); // overlaps the booked time by 10 minutes, but only 25 of its 50 minutes are inside 09:45-11:15: exactly half is not more than half
  });

  it("does not match a recording that overlaps the booked time by 5 minutes at the edge but lies mostly outside the widened window", () => {
    const w = [win("a", "10:00", "10:30")];
    expect(matchMeeting(meeting("09:00", "10:05"), w)).toBeNull(); // 65 minutes, only 20 inside 09:45-10:45
    expect(matchMeeting(meeting("10:25", "11:30"), w)).toBeNull(); // 65 minutes, only 20 inside
  });

  it("does not match a 60-minute recording of which only 20 minutes fall inside the widened window", () => {
    expect(matchMeeting(meeting("10:25", "11:25"), [win("a", "10:00", "10:30")])).toBeNull(); // inside 09:45-10:45 is 10:25-10:45
  });

  it("matches a call that starts 5 minutes late and runs 10 minutes over", () => {
    expect(matchMeeting(meeting("10:05", "10:40"), [win("a", "10:00", "10:30")])).toBe("a");
  });

  it("matches a recording that started a little before the window, and not one that never touches it", () => {
    expect(matchMeeting(meeting("09:50", "10:30"), [win("a", "10:00", "11:00")])).toBe("a");
    expect(matchMeeting(meeting("09:30", "09:40"), [win("a", "10:00", "11:00")])).toBeNull();
  });

  it("matches nothing for a recording with no length", () => {
    expect(matchMeeting(meeting("10:10", "10:10"), [win("a", "10:00", "11:00")])).toBeNull();
    expect(matchMeeting(meeting("10:10", "10:05"), [win("a", "10:00", "11:00")])).toBeNull();
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
    // with no tolerance a recording must be mostly inside the booked time itself
    expect(matchMeeting(meeting("10:40", "11:20"), [win("a", "10:00", "11:00")], 0)).toBeNull();
    expect(matchMeeting(meeting("10:20", "11:05"), [win("a", "10:00", "11:00")], 0)).toBe("a");
  });

  it("ignores a window whose times are not dates", () => {
    expect(matchMeeting(meeting("10:00", "11:00"), [{ key: "bad", startAt: "soon", endAt: "later" }, win("a", "10:00", "11:00")])).toBe("a");
  });
});
