import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobHandler } from "../loop.ts";
import { matchMeeting } from "../meetily/match.ts";
import { readMeetings, type RawMeeting } from "../meetily/read.ts";
import { payloadOf, textField } from "./clone.ts";

/** What the server accepts in one file (MatchedMeetingsFile on the Worker). Cut here so a long meeting is sent short rather than refused. */
const MAX_MEETINGS = 50;
const MAX_TITLE = 300;
const MAX_NOTES = 50_000;
const MAX_LINES = 20_000;
const MAX_LINE_TEXT = 5000;
/** The most transcript lines the whole file may hold, and the most bytes it may be (the Worker refuses a file over 12 MB without reading it). */
const MAX_TOTAL_LINES = 50_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
// `{"meetings":[` and `]}`; each entry after the first also costs a comma.
const FILE_OVERHEAD = bytes({ meetings: [] });

interface Window { key: string; startAt: string; endAt: string }

function windowsOf(o: Record<string, unknown>): Window[] {
  const raw = o.windows;
  if (!Array.isArray(raw)) throw new Error("the job's windows is missing (it should be a list of time windows)");
  return raw.map((w, i) => {
    if (!w || typeof w !== "object") throw new Error(`the job's windows[${i}] is not a time window`);
    const x = w as Record<string, unknown>;
    return { key: textField(x, "key"), startAt: textField(x, "startAt"), endAt: textField(x, "endAt") };
  });
}

function knownIdsOf(o: Record<string, unknown>): Set<string> {
  const raw = o.knownMeetilyIds ?? [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw new Error("the job's knownMeetilyIds should be a list of ids");
  return new Set(raw as string[]);
}

interface Entry {
  meetilyId: string; windowKey: string; title: string; startedAt: string; endedAt: string; notes: string | null;
  transcript: { speaker: string | null; atSec: number | null; text: string }[];
}

/** One meeting as the server takes it, cut to the per-field sizes. */
function entryOf(m: RawMeeting, windowKey: string): Entry {
  return {
    meetilyId: m.meetilyId,
    windowKey,
    title: m.title.slice(0, MAX_TITLE),
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    notes: m.notes === null ? null : m.notes.slice(0, MAX_NOTES),
    transcript: m.transcript
      .filter((l) => l.text.trim())
      .slice(0, MAX_LINES)
      .map((l) => ({ speaker: l.speaker, atSec: l.atSec, text: l.text.slice(0, MAX_LINE_TEXT) })),
  };
}

/** Drops transcript lines from the end until the entry's own JSON is at most `budget` bytes. Nothing else about it changes. */
function fitToBudget(e: Entry, budget: number): void {
  let total = bytes(e);
  while (total > budget && e.transcript.length) {
    const last = e.transcript.pop()!;
    total -= bytes(last) + 1;
  }
}

/**
 * `meetily.sync`: reads Meetily's recordings on this Mac, matches each one to a booking or calendar window from the job, and uploads ONLY the matched
 * meetings (as JSON, to the job's one output key). Meetings that match nothing stay on the Mac and are not mentioned anywhere, including the result and the logs.
 */
export function meetilySyncHandler(now: () => Date = () => new Date()): JobHandler {
  return {
    kind: "meetily.sync",
    async run({ job, api, cfg, workDir }) {
      if (job.outputs.length !== 1) throw new Error(`this job should have one output file and has ${job.outputs.length}`);
      const outKey = job.outputs[0];
      const payload = payloadOf(job);
      const windows = windowsOf(payload);
      const since = textField(payload, "since");
      if (!Number.isFinite(Date.parse(since))) throw new Error("the job's since is not a date");
      const skipIds = knownIdsOf(payload);

      const { meetings, scanned } = readMeetings(cfg.meetilyDb, { sinceIso: since, skipIds, now: now() });

      const candidates = meetings
        .flatMap((m) => { const windowKey = matchMeeting(m, windows); return windowKey === null ? [] : [{ m, windowKey }]; })
        .sort((a, b) => a.m.startedAt.localeCompare(b.m.startedAt))
        .slice(0, MAX_MEETINGS);

      // Oldest first, until the file would pass its byte or line budget. What is left out is not in the file, so the server does not know it yet and the next sync sends it.
      const entries: Entry[] = [];
      let size = FILE_OVERHEAD, lines = 0;
      for (const { m, windowKey } of candidates) {
        const entry = entryOf(m, windowKey);
        if (entries.length === 0) fitToBudget(entry, MAX_FILE_BYTES - FILE_OVERHEAD); // a first meeting that alone is too big loses its last lines instead of blocking every later sync
        const cost = bytes(entry) + (entries.length ? 1 : 0);
        if (entries.length && (size + cost > MAX_FILE_BYTES || lines + entry.transcript.length > MAX_TOTAL_LINES)) break;
        entries.push(entry);
        size += cost;
        lines += entry.transcript.length;
      }
      if (!entries.length) return { scanned, matched: 0, key: null };
      const file = { meetings: entries };
      const path = join(workDir, "meetings.json");
      await writeFile(path, JSON.stringify(file));
      await api.upload(job.id, outKey, path, "application/json");
      return { scanned, matched: entries.length, key: outKey };
    },
  };
}
