import { describe, it, expect } from "vitest";
import { crossedMarks, PROGRESS_MARKS, WATCHED_HEADING, percentPlayed, watchedLine } from "../src/client/videoViewsView";

const now = new Date("2026-11-18T12:00:00.000Z");
const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

describe("watchedLine", () => {
  it("reads Watched N% and how long ago", () => {
    expect(watchedLine({ maxPct: 50, lastAt: at(5 * 60_000) }, now)).toBe("Watched 50% 5m ago");
    expect(watchedLine({ maxPct: 100, lastAt: at(3 * 3_600_000) }, now)).toBe("Watched 100% 3h ago");
    expect(watchedLine({ maxPct: 75, lastAt: at(2 * 86_400_000) }, now)).toBe("Watched 75% 2d ago");
    expect(watchedLine({ maxPct: 50, lastAt: at(10_000) }, now)).toBe("Watched 50% just now");
  });
});

describe("the Today card", () => {
  it("has its heading", () => { expect(WATCHED_HEADING).toBe("Watched your video, no reply yet"); });
});

describe("watch depth on the report page", () => {
  it("reports 25, 50, 75 and 90, each once", () => {
    expect(PROGRESS_MARKS).toEqual([25, 50, 75, 90]);
    expect(crossedMarks(10, new Set())).toEqual([]);
    expect(crossedMarks(25, new Set())).toEqual([25]);
    expect(crossedMarks(60, new Set([25]))).toEqual([50]);
    expect(crossedMarks(100, new Set([25, 50, 75, 90]))).toEqual([]);
  });
  it("a jump forward crosses every mark it passed, lowest first", () => {
    expect(crossedMarks(80, new Set())).toEqual([25, 50, 75]);
  });
  it("percentPlayed is whole percent of the duration, and nothing for an unknown length", () => {
    expect(percentPlayed(30, 120)).toBe(25);
    expect(percentPlayed(119.9, 120)).toBe(99);
    expect(percentPlayed(200, 120)).toBe(100);
    expect(percentPlayed(5, 0)).toBe(0);
    expect(percentPlayed(5, Number.NaN)).toBe(0);
    expect(percentPlayed(5, Number.POSITIVE_INFINITY)).toBe(0);
    expect(percentPlayed(-3, 120)).toBe(0);
  });
});
