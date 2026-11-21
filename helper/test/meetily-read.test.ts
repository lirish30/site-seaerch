import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMeetings } from "../src/meetily/read.ts";
import { makeMeetilyDb, meetilyTs, SECRET, type FixtureMeeting } from "./fixtures/meetily.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "helper-meetily-read-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-18T12:00:00Z");
const SINCE = "2026-11-10T00:00:00Z";
const read = (meetings: FixtureMeeting[], o: Partial<Parameters<typeof readMeetings>[1]> = {}) =>
  readMeetings(makeMeetilyDb(dir, { meetings }), { sinceIso: SINCE, skipIds: new Set(), now: NOW, ...o });

describe("readMeetings", () => {
  it("ends a meeting at created_at plus the largest audio_end_time, and puts the lines in audio_start_time order", () => {
    const { meetings, scanned } = read([{
      id: "m1", title: "Kickoff", createdAt: "2026-11-17T23:00:00Z", updatedAt: "2026-11-18T09:00:00Z",
      lines: [
        { text: "second", startSec: 20, endSec: 4500, speaker: "Ana" },
        { text: "first", startSec: 1, endSec: 19 },
        { text: "unmarked", startSec: null, endSec: null },
      ],
    }]);
    expect(scanned).toBe(1);
    expect(meetings).toHaveLength(1);
    const m = meetings[0];
    expect(m.meetilyId).toBe("m1");
    expect(m.title).toBe("Kickoff");
    expect(m.startedAt).toBe("2026-11-17T23:00:00.000Z");
    expect(m.endedAt).toBe("2026-11-18T00:15:00.000Z"); // 4500 s later, not the 09:00 updated_at
    expect(m.transcript).toEqual([
      { speaker: null, atSec: 1, text: "first" },
      { speaker: "Ana", atSec: 20, text: "second" },
      { speaker: null, atSec: null, text: "unmarked" },
    ]);
  });

  it("falls back to updated_at when no line has an end time, and reads Meetily's microsecond timestamps", () => {
    const { meetings } = read([{ id: "m1", title: "No audio times", createdAt: "2026-11-17T23:11:58.787Z", updatedAt: "2026-11-18T01:11:58.787Z", lines: [{ text: "hello" }] }]);
    expect(meetings[0].startedAt).toBe("2026-11-17T23:11:58.787Z");
    expect(meetings[0].endedAt).toBe("2026-11-18T01:11:58.787Z");
    expect(meetings[0].transcript).toEqual([{ speaker: null, atSec: null, text: "hello" }]);
  });

  it("skips a meeting still being recorded (updated under 5 minutes before now), but not one updated 6 minutes ago", () => {
    const { meetings, scanned } = read([
      { id: "live", title: "Live", createdAt: "2026-11-18T11:00:00Z", updatedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString() },
      { id: "done", title: "Done", createdAt: "2026-11-18T11:00:00Z", updatedAt: new Date(NOW.getTime() - 6 * 60_000).toISOString() },
    ]);
    expect(meetings.map((m) => m.meetilyId)).toEqual(["done"]);
    expect(scanned).toBe(1);
  });

  it("skips meetings from before sinceIso and meetings in skipIds", () => {
    const { meetings } = read([
      { id: "old", title: "Old", createdAt: "2026-11-01T10:00:00Z" },
      { id: "known", title: "Known", createdAt: "2026-11-15T10:00:00Z" },
      { id: "new", title: "New", createdAt: "2026-11-16T10:00:00Z" },
    ], { skipIds: new Set(["known"]) });
    expect(meetings.map((m) => m.meetilyId)).toEqual(["new"]);
  });

  it("takes the note from summary_processes.result (plain text, or the markdown of a JSON result) and gives null when there is none", () => {
    const { meetings } = read([
      { id: "plain", title: "A", createdAt: "2026-11-16T10:00:00Z", summary: "## Decisions\n- ship it" },
      { id: "json", title: "B", createdAt: "2026-11-16T11:00:00Z", summary: "# Notes\nbody", summaryAsJson: true },
      { id: "none", title: "C", createdAt: "2026-11-16T12:00:00Z" },
    ]);
    const note = Object.fromEntries(meetings.map((m) => [m.meetilyId, m.notes]));
    expect(note).toEqual({ plain: "## Decisions\n- ship it", json: "# Notes\nbody", none: null });
  });

  it("throws a plain sentence when the file is not there", () => {
    const missing = join(dir, "nope", "meeting_minutes.sqlite");
    expect(() => readMeetings(missing, { sinceIso: SINCE, skipIds: new Set(), now: NOW })).toThrow(`Meetily's database was not found at ${missing}. Is Meetily installed?`);
  });

  it("throws a plain sentence when the database stays locked", () => {
    const path = makeMeetilyDb(dir, { meetings: [{ id: "m1", title: "T", createdAt: "2026-11-16T10:00:00Z" }] });
    const writer = new DatabaseSync(path);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => readMeetings(path, { sinceIso: SINCE, skipIds: new Set(), now: NOW, busyTimeoutMs: 50 })).toThrow(/Meetily is busy with its database \(it may be recording or saving\)/);
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  });

  it("never reads the settings, transcript_settings or licensing tables", () => {
    const { meetings } = read([{ id: "m1", title: "T", createdAt: "2026-11-16T10:00:00Z", lines: [{ text: "x", startSec: 0, endSec: 5 }], summary: "s" }]);
    expect(JSON.stringify(meetings)).not.toContain(SECRET);
    const src = readFileSync(new URL("../src/meetily/read.ts", import.meta.url), "utf8");
    for (const table of ["settings", "transcript_settings", "licensing"]) expect(src).not.toMatch(new RegExp(`\\b${table}\\b`));
  });

  it("leaves the file exactly as it found it (same bytes, same modified time)", () => {
    const path = makeMeetilyDb(dir, { meetings: [{ id: "m1", title: "T", createdAt: "2026-11-16T10:00:00Z", lines: [{ text: "x", startSec: 0, endSec: 5 }] }] });
    utimesSync(path, new Date("2026-11-17T00:00:00Z"), new Date("2026-11-17T00:00:00Z"));
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
    readMeetings(path, { sinceIso: SINCE, skipIds: new Set(), now: NOW });
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
  });
});

describe("the fixture", () => {
  it("writes Meetily's real timestamp format", () => {
    expect(meetilyTs("2026-11-17T23:11:58.787Z")).toBe("2026-11-17T23:11:58.787000+00:00");
  });
});
