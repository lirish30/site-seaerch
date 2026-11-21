import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobHandler } from "../loop.ts";
import { matchMeeting } from "../meetily/match.ts";
import { readMeetings } from "../meetily/read.ts";
import { payloadOf, textField } from "./clone.ts";

/** What the server accepts in one file (MatchedMeetingsFile on the Worker). Cut here so a long meeting is sent short rather than refused. */
const MAX_MEETINGS = 50;
const MAX_TITLE = 300;
const MAX_NOTES = 50_000;
const MAX_LINES = 20_000;
const MAX_LINE_TEXT = 5000;

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

      const matched = meetings
        .flatMap((m) => { const windowKey = matchMeeting(m, windows); return windowKey === null ? [] : [{ m, windowKey }]; })
        .sort((a, b) => a.m.startedAt.localeCompare(b.m.startedAt))
        .slice(0, MAX_MEETINGS); // the rest are not in the file, so the next sync picks them up
      if (!matched.length) return { scanned, matched: 0, key: null };

      const file = {
        meetings: matched.map(({ m, windowKey }) => ({
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
        })),
      };
      const path = join(workDir, "meetings.json");
      await writeFile(path, JSON.stringify(file));
      await api.upload(job.id, outKey, path, "application/json");
      return { scanned, matched: matched.length, key: outKey };
    },
  };
}
