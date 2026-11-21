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
let n = 0;
const read = (meetings: FixtureMeeting[], o: Partial<Parameters<typeof readMeetings>[1]> = {}) =>
  readMeetings(makeMeetilyDb(dir, { meetings, name: `m${n++}.sqlite` }), { sinceIso: SINCE, skipIds: new Set(), now: NOW, ...o });

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

  const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
  const ids = (r: { meetings: { meetilyId: string }[] }) => r.meetings.map((m) => m.meetilyId);

  it("skips a meeting whose record changed under 5 minutes ago, but still counts it as scanned", () => {
    const r = read([
      { id: "live", title: "Live", createdAt: minsAgo(60), updatedAt: minsAgo(2), summary: "s" },
      { id: "done", title: "Done", createdAt: minsAgo(60), updatedAt: minsAgo(6), summary: "s" },
    ]);
    expect(ids(r)).toEqual(["done"]);
    expect(r.scanned).toBe(2);
  });

  it("skips a meeting whose audio ended under 5 minutes ago even though meetings.updated_at is old", () => {
    const r = read([
      { id: "live", title: "Live", createdAt: minsAgo(62), updatedAt: minsAgo(61), summary: "s", lines: [{ text: "still talking", startSec: 1, endSec: 3600 }] }, // ends 2 minutes ago
      { id: "done", title: "Done", createdAt: minsAgo(70), updatedAt: minsAgo(61), summary: "s", lines: [{ text: "finished", startSec: 1, endSec: 3600 }] }, // ended 10 minutes ago
    ]);
    expect(ids(r)).toEqual(["done"]);
    expect(r.scanned).toBe(2);
  });

  it("skips a meeting whose summary was touched under 5 minutes ago", () => {
    const r = read([{ id: "m", title: "T", createdAt: minsAgo(120), updatedAt: minsAgo(100), summary: "s", summaryUpdatedAt: minsAgo(3) }]);
    expect(ids(r)).toEqual([]);
  });

  it("skips (does not upload) a meeting whose updated_at cannot be read", () => {
    const r = read([
      { id: "bad", title: "Bad", createdAt: minsAgo(300), rawUpdatedAt: "not a date", summary: "s" },
      { id: "ok", title: "Ok", createdAt: minsAgo(300), summary: "s" },
    ]);
    expect(ids(r)).toEqual(["ok"]);
    expect(r.scanned).toBe(2);
  });

  describe("a summary that is not written yet", () => {
    const base = { title: "T", createdAt: minsAgo(300), updatedAt: minsAgo(280) }; // ended 280 minutes ago
    it("waits for a pending or processing summary, then sends the meeting with its notes once completed", () => {
      const path = (status: string, summary: string | null, name: string) => makeMeetilyDb(dir, { name, meetings: [{ id: "m", ...base, summaryStatus: status, summary }] });
      const opts = { sinceIso: SINCE, skipIds: new Set<string>(), now: NOW };
      for (const status of ["pending", "processing"]) expect(readMeetings(path(status, null, `${status}.sqlite`), opts)).toMatchObject({ meetings: [], scanned: 1 });
      const done = readMeetings(path("completed", "The notes", "done.sqlite"), opts);
      expect(done.meetings.map((m) => m.notes)).toEqual(["The notes"]);
    });
    it("waits for a completed row that has no result yet", () => {
      expect(ids(read([{ id: "m", ...base, summaryStatus: "completed", summary: null }]))).toEqual([]);
    });
    it("sends a meeting whose summary failed, with no notes", () => {
      const r = read([{ id: "f", ...base, summaryStatus: "failed" }, { id: "e", ...base, summaryStatus: "error" }]);
      expect(r.meetings.map((m) => [m.meetilyId, m.notes])).toEqual([["f", null], ["e", null]]);
    });
    it("gives a meeting with no summary row 30 minutes to get one, then sends it with notes null", () => {
      const at = (endedMinsAgo: number) => read([{ id: "m", title: "T", createdAt: minsAgo(endedMinsAgo + 10), updatedAt: minsAgo(endedMinsAgo) }]);
      expect(ids(at(29))).toEqual([]);
      const late = at(31);
      expect(late.meetings.map((m) => m.notes)).toEqual([null]);
    });
    it("stops waiting for a stuck processing summary 24 hours after the meeting ended", () => {
      const at = (endedHoursAgo: number) => read([{ id: "m", title: "T", createdAt: minsAgo(endedHoursAgo * 60 + 10), updatedAt: minsAgo(endedHoursAgo * 60), summaryStatus: "processing" }]);
      expect(ids(at(23))).toEqual([]);
      expect(at(25).meetings.map((m) => m.notes)).toEqual([null]);
    });
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

  it("reads a WAL-mode database and leaves its main file exactly as it was", () => {
    const path = makeMeetilyDb(dir, { wal: true, meetings: [{ id: "m1", title: "T", createdAt: "2026-11-16T10:00:00Z", summary: "s", lines: [{ text: "x", startSec: 0, endSec: 5 }] }] });
    expect(new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
    const { meetings } = readMeetings(path, { sinceIso: SINCE, skipIds: new Set(), now: NOW });
    expect(meetings.map((m) => m.meetilyId)).toEqual(["m1"]);
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
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
