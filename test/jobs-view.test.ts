import { describe, it, expect } from "vitest";
import { ageLabel, atsLabel, seenRecently, sourceLine } from "../src/client/jobsView";
import { TODAY_KIND_LABEL } from "../src/client/todayView";
import type { CareerSource, JobPosting } from "../src/client/types";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const p = (o: Partial<JobPosting>): JobPosting => ({ id: "1", business_id: "b", external_id: "1", title: "SEO", url: "https://x.example", location: null, department: null,
  role_kind: "seo", posted_at: null, first_seen_at: day(0), last_seen_at: day(0), closed_at: null, baseline: false, ...o });
const s = (o: Partial<CareerSource>): CareerSource => ({ business_id: "b", status: "active", ats: "lever", token: "acme", careers_url: null, checked_at: day(0), last_ok_at: day(0),
  next_check_at: day(0), empty_streak: 0, last_error: null, created_at: day(9), ...o });

describe("ageLabel", () => {
  it("uses the board's date when it has one", () => {
    expect(ageLabel(p({ posted_at: day(0) }), NOW)).toBe("Posted today");
    expect(ageLabel(p({ posted_at: day(1) }), NOW)).toBe("Posted 1 day ago");
    expect(ageLabel(p({ posted_at: day(45) }), NOW)).toBe("Posted 45 days ago");
  });
  it("falls back to when we first saw it", () => {
    expect(ageLabel(p({ first_seen_at: day(0) }), NOW)).toBe("First seen today");
    expect(ageLabel(p({ first_seen_at: day(2) }), NOW)).toBe("First seen 2 days ago");
  });
  it("does not claim an age for a role found on the first look at a board", () => {
    expect(ageLabel(p({ baseline: true, first_seen_at: day(3) }), NOW)).toBe("Age unknown (on their board since at least Oct 11)");
  });
  it("says the age is unknown when the date it would use does not parse", () => {
    expect(ageLabel(p({ posted_at: "garbage" }), NOW)).toBe("Age unknown");
    expect(ageLabel(p({ baseline: true, first_seen_at: "garbage" }), NOW)).toBe("Age unknown");
    expect(ageLabel(p({ first_seen_at: "garbage" }), NOW)).toBe("Age unknown");
  });
});

describe("sourceLine", () => {
  it("describes each state of a lead's board", () => {
    expect(sourceLine(null)).toBe("Not checked yet");
    expect(sourceLine(s({}))).toBe("Watching their Lever board");
    expect(sourceLine(s({ ats: "greenhouse", last_error: "greenhouse answered 502" }))).toBe("Watching their Greenhouse board. Last check failed: greenhouse answered 502");
    expect(sourceLine(s({ status: "none", ats: null, token: null }))).toBe("No supported job board found on their site");
    expect(sourceLine(s({ status: "error", last_error: "timeout" }))).toBe("Couldn't read their careers page: timeout");
  });
  it("names the boards", () => {
    expect([atsLabel("greenhouse"), atsLabel("lever"), atsLabel("ashby")]).toEqual(["Greenhouse", "Lever", "Ashby"]);
  });
});

describe("seenRecently", () => {
  const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  it("counts a role the board showed within 48 hours", () => {
    expect(seenRecently({ last_seen_at: ago(47) }, NOW)).toBe(true);
    expect(seenRecently({ last_seen_at: ago(48) }, NOW)).toBe(true);
  });
  it("drops a role last shown more than 48 hours ago", () => {
    expect(seenRecently({ last_seen_at: ago(48.01) }, NOW)).toBe(false);
  });
  it("treats an unparseable date as not recent", () => {
    expect(seenRecently({ last_seen_at: "not a date" }, NOW)).toBe(false);
  });
});

describe("Today", () => {
  it("labels the new kind", () => expect(TODAY_KIND_LABEL.open_role).toBe("Hiring"));
});
