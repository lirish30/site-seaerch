import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import { meetilySyncHandler } from "../src/handlers/meetilySync.ts";
import type { JobApi } from "../src/loop.ts";
import { makeMeetilyDb, SECRET, type FixtureMeeting } from "./fixtures/meetily.ts";

let dir: string;
let dbDir: string;
let workDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "helper-meetily-handler-"));
  dbDir = join(dir, "db");
  workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const NOW = new Date("2026-11-18T12:00:00Z");
const OUT = "helper-out/sync-1/meetings.json";

const cfgFor = (meetilyDb: string): Config => ({
  apiBase: "https://x.example.com", token: "hlp_x", pollSeconds: 5, cacheDir: dir, meetilyDb,
  python: { "qwen3-tts": "p", chatterbox: "p", "openvoice-v2": "p" }, ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: "hyperframes",
});

const job = (payload: unknown, o: Partial<ClaimedJob> = {}): ClaimedJob => ({ id: "job-1", kind: "meetily.sync", attempts: 1, payload, inputs: [], outputs: [OUT], ...o });
const goodPayload = (o: Record<string, unknown> = {}) => ({
  syncId: "sync-1", since: "2026-11-10T00:00:00Z", knownMeetilyIds: [],
  windows: [{ key: "booking:1", businessId: "b1", startAt: "2026-11-17T10:00:00Z", endAt: "2026-11-17T11:00:00Z", bookingId: "bk1", source: "booking" }],
  ...o,
});

const meetings: FixtureMeeting[] = [
  { id: "match", title: "Kickoff with Dana", createdAt: "2026-11-17T10:05:00Z", updatedAt: "2026-11-17T10:55:00Z", summary: "They want a new site.", lines: [{ text: "we need a new site", startSec: 2, endSec: 3000, speaker: "Dana" }] },
  { id: "other1", title: "Dentist chat", createdAt: "2026-11-17T14:00:00Z", updatedAt: "2026-11-17T14:30:00Z", summary: "Private dental notes", lines: [{ text: "my molar hurts", startSec: 1, endSec: 1800 }] },
  { id: "other2", title: "Family call", createdAt: "2026-11-16T20:00:00Z", updatedAt: "2026-11-16T20:40:00Z", lines: [{ text: "grandma recipe", startSec: 1, endSec: 2400 }] },
];

function setup() {
  const uploads: { jobId: string; key: string; contentType: string; body: string }[] = [];
  const api = {
    upload: async (jobId: string, key: string, path: string, contentType: string) => { uploads.push({ jobId, key, contentType, body: readFileSync(path, "utf8") }); },
  } as unknown as JobApi;
  return { uploads, api };
}

async function run(j: ClaimedJob, ms: FixtureMeeting[] = meetings) {
  const db = makeMeetilyDb(mkdtempSync(join(dbDir, "db-")), { meetings: ms });
  const { uploads, api } = setup();
  const logged: string[] = [];
  for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  const result = await meetilySyncHandler(() => NOW).run({ job: j, api, cfg: cfgFor(db), workDir });
  return { uploads, result, logged };
}

describe("meetilySyncHandler", () => {
  it("has the kind meetily.sync", () => { expect(meetilySyncHandler().kind).toBe("meetily.sync"); });

  it("uploads one file holding only the matched meeting, and nothing about the others leaves the Mac", async () => {
    const { uploads, result, logged } = await run(job(goodPayload()));
    expect(result).toEqual({ scanned: 3, matched: 1, key: OUT });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ jobId: "job-1", key: OUT, contentType: "application/json" });
    expect(JSON.parse(uploads[0].body)).toEqual({
      meetings: [{
        meetilyId: "match", windowKey: "booking:1", title: "Kickoff with Dana", startedAt: "2026-11-17T10:05:00.000Z", endedAt: "2026-11-17T10:55:00.000Z",
        notes: "They want a new site.", transcript: [{ speaker: "Dana", atSec: 2, text: "we need a new site" }],
      }],
    });
    const everything = [uploads[0].body, JSON.stringify(result), ...logged].join("\n");
    for (const secret of ["Dentist chat", "Private dental notes", "my molar hurts", "Family call", "grandma recipe", SECRET]) expect(everything).not.toContain(secret);
  });

  it("does not upload a neighbouring recording: its title and words are in no upload, result or log", async () => {
    // The client call is booked 10:00-11:00. Right before it a Webfor stand-up ends exactly at 10:00, right after it another starts exactly at 11:00,
    // and a long one only overlaps the booked time by 5 minutes at the edge.
    const neighbours: FixtureMeeting[] = [
      meetings[0],
      { id: "before", title: "Webfor stand-up", createdAt: "2026-11-17T09:30:00Z", updatedAt: "2026-11-17T10:00:00Z", summary: "Webfor roadmap notes", lines: [{ text: "webfor sprint words", startSec: 1, endSec: 1800 }] },
      { id: "after", title: "Webfor retro", createdAt: "2026-11-17T11:00:00Z", updatedAt: "2026-11-17T11:30:00Z", summary: "Webfor retro notes", lines: [{ text: "webfor retro words", startSec: 1, endSec: 1800 }] },
      { id: "long", title: "Webfor planning day", createdAt: "2026-11-17T08:00:00Z", updatedAt: "2026-11-17T10:05:00Z", summary: "Webfor planning notes", lines: [{ text: "webfor planning words", startSec: 1, endSec: 7500 }] },
    ];
    const { uploads, result, logged } = await run(job(goodPayload()), neighbours);
    expect(result).toEqual({ scanned: 4, matched: 1, key: OUT });
    expect(JSON.parse(uploads[0].body).meetings.map((m: { meetilyId: string }) => m.meetilyId)).toEqual(["match"]);
    const everything = [uploads[0].body, JSON.stringify(result), ...logged].join("\n");
    for (const secret of ["Webfor", "webfor", "stand-up", "retro", "planning"]) expect(everything).not.toContain(secret);
  });

  it("uploads nothing and returns key null when nothing matches", async () => {
    const { uploads, result } = await run(job(goodPayload({ windows: [{ key: "w", businessId: "b", startAt: "2026-11-01T10:00:00Z", endAt: "2026-11-01T11:00:00Z", bookingId: null, source: "calendar" }] })));
    expect(result).toEqual({ scanned: 3, matched: 0, key: null });
    expect(uploads).toHaveLength(0);
  });

  it("does not read meetings the server already has", async () => {
    const { result, uploads } = await run(job(goodPayload({ knownMeetilyIds: ["match"] })));
    expect(result).toEqual({ scanned: 2, matched: 0, key: null });
    expect(uploads).toHaveLength(0);
  });

  it("cuts a title, note and lines down to the sizes the server accepts, and sends at most 50 meetings", async () => {
    const big: FixtureMeeting[] = Array.from({ length: 52 }, (_, i) => ({
      id: `m${String(i).padStart(2, "0")}`, title: "T".repeat(400), createdAt: new Date(Date.parse("2026-11-17T10:00:00Z") + i * 1000).toISOString(), updatedAt: "2026-11-17T10:50:00Z",
      summary: i === 0 ? "N".repeat(60_000) : "ok", lines: i === 0 ? [{ text: "L".repeat(6000), startSec: 1, endSec: 2 }] : [{ text: "x", startSec: 1, endSec: 2 }],
    }));
    const { result, uploads } = await run(job(goodPayload()), big);
    expect(result).toMatchObject({ scanned: 52, matched: 50 });
    const sent = JSON.parse(uploads[0].body).meetings as { title: string; notes: string; transcript: { text: string }[] }[];
    expect(sent).toHaveLength(50);
    expect(sent[0].title).toHaveLength(300);
    expect(sent[0].notes).toHaveLength(50_000);
    expect(sent[0].transcript[0].text).toHaveLength(5000);
  });

  const sentOf = (body: string) => JSON.parse(body).meetings as { meetilyId: string; transcript: { text: string }[] }[];
  // Every line sits in the first second, so a many-line recording is still short enough to match its booking (a recording's length is its last line's end).
  const manyLines = (n: number, text: string) => Array.from({ length: n }, (_, i) => ({ text: `${i}:${text}`, startSec: 0, endSec: 1 }));

  it("stops adding meetings, oldest first, once the file would pass 10 MB, and the rest wait for the next sync", async () => {
    // Each meeting is about 1.9 MB: 400 lines of 4,800 characters.
    const heavy: FixtureMeeting[] = Array.from({ length: 8 }, (_, i) => ({
      id: `h${i}`, title: "Heavy", createdAt: new Date(Date.parse("2026-11-17T10:00:00Z") + i * 1000).toISOString(), updatedAt: "2026-11-17T10:50:00Z", lines: manyLines(400, "y".repeat(4_800)),
    }));
    const { result, uploads } = await run(job(goodPayload()), heavy);
    expect(Buffer.byteLength(uploads[0].body)).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(sentOf(uploads[0].body).map((m) => m.meetilyId)).toEqual(["h0", "h1", "h2", "h3", "h4"]);
    expect(result).toEqual({ scanned: 8, matched: 5, key: OUT });
  });

  it("cuts a single meeting that is over 10 MB by dropping its last lines until it fits, and changes nothing else", async () => {
    const huge: FixtureMeeting[] = [{ id: "huge", title: "Huge", createdAt: "2026-11-17T10:05:00Z", updatedAt: "2026-11-17T10:55:00Z", summary: "notes stay", lines: manyLines(3_000, "z".repeat(4_900)) }];
    const { result, uploads } = await run(job(goodPayload()), huge);
    expect(Buffer.byteLength(uploads[0].body)).toBeLessThanOrEqual(10 * 1024 * 1024);
    const [m] = JSON.parse(uploads[0].body).meetings as { title: string; notes: string; transcript: { text: string }[] }[];
    expect(m.title).toBe("Huge");
    expect(m.notes).toBe("notes stay");
    expect(m.transcript.length).toBeGreaterThan(1_500);
    expect(m.transcript.length).toBeLessThan(3_000);
    expect(m.transcript[0].text.startsWith("0:")).toBe(true); // the start is kept, the end is cut
    expect(m.transcript.at(-1)!.text.startsWith(`${m.transcript.length - 1}:`)).toBe(true);
    expect(result).toEqual({ scanned: 1, matched: 1, key: OUT });
  });

  it("stops adding meetings once the file would hold more than 50,000 lines in all", async () => {
    const lined: FixtureMeeting[] = Array.from({ length: 4 }, (_, i) => ({
      id: `l${i}`, title: "Lines", createdAt: new Date(Date.parse("2026-11-17T10:00:00Z") + i * 1000).toISOString(), updatedAt: "2026-11-17T10:50:00Z", lines: manyLines(17_000, "a"),
    }));
    const { result, uploads } = await run(job(goodPayload()), lined);
    expect(sentOf(uploads[0].body).map((m) => m.meetilyId)).toEqual(["l0", "l1"]); // a third would make 51,000
    expect(sentOf(uploads[0].body).reduce((n, m) => n + m.transcript.length, 0)).toBeLessThanOrEqual(50_000);
    expect(result).toMatchObject({ scanned: 4, matched: 2 });
  }, 90_000);

  it("names the field when the payload has no windows", async () => {
    const { windows: _w, ...rest } = goodPayload();
    await expect(run(job(rest))).rejects.toThrow(/windows/);
    await expect(run(job(goodPayload({ windows: "soon" })))).rejects.toThrow(/windows/);
    await expect(run(job(goodPayload({ since: undefined })))).rejects.toThrow(/since/);
  });

  it("needs exactly one output key", async () => {
    await expect(run(job(goodPayload(), { outputs: [] }))).rejects.toThrow(/output/);
  });

  it("fails with a plain sentence when Meetily is not installed", async () => {
    const { api } = setup();
    const missing = join(dir, "no", "meeting_minutes.sqlite");
    await expect(meetilySyncHandler(() => NOW).run({ job: job(goodPayload()), api, cfg: cfgFor(missing), workDir })).rejects.toThrow(`Meetily's database was not found at ${missing}. Is Meetily installed?`);
  });
});
