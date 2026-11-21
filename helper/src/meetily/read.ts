import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Meetily keeps API keys and its licence in the same database file. These three tables are the only ones this helper ever names; no query
 * below mentions any other table, so a key cannot reach an upload or a log line.
 */
const MEETINGS = "meetings";
const TRANSCRIPTS = "transcripts";
const SUMMARIES = "summary_processes";

/** A meeting whose record changed this recently is probably still being recorded. */
const STILL_RECORDING_MS = 5 * 60_000;
const DEFAULT_BUSY_TIMEOUT_MS = 3000;

export interface RawMeeting {
  meetilyId: string;
  title: string;
  startedAt: string;
  endedAt: string;
  notes: string | null;
  transcript: { speaker: string | null; atSec: number | null; text: string }[];
}

interface MeetingRow { id: string; title: string | null; created_at: string; updated_at: string }
interface LineRow { transcript: string | null; audio_start_time: number | null; audio_end_time: number | null; speaker: string | null }
interface SummaryRow { result: string | null }

/** The note Meetily wrote: its summary text, whether stored as plain text or as JSON with a `markdown` field. */
function noteOf(result: string | null | undefined): string | null {
  if (typeof result !== "string" || !result.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "string") return parsed.trim() ? parsed : null;
    if (parsed && typeof parsed === "object" && typeof (parsed as { markdown?: unknown }).markdown === "string") {
      const md = (parsed as { markdown: string }).markdown;
      return md.trim() ? md : null;
    }
  } catch { /* plain text, not JSON */ }
  return result;
}

const isBusy = (e: unknown): boolean => {
  const err = e as { errcode?: number; message?: string } | null;
  return err?.errcode === 5 || err?.errcode === 6 || /database is locked|database table is locked/i.test(err?.message ?? "");
};

/**
 * Meetings Meetily has recorded since `sinceIso`, read straight from its database and never changed (opened read-only). A meeting is left out when
 * it is in `skipIds`, started before `sinceIso`, or was updated under five minutes before `now` (still recording). `scanned` is the number read.
 * A meeting ends `max(audio_end_time)` seconds after it began, or at `updated_at` when its lines carry no end times.
 */
export function readMeetings(
  dbPath: string,
  o: { sinceIso: string; skipIds: ReadonlySet<string>; now: Date; busyTimeoutMs?: number },
): { meetings: RawMeeting[]; scanned: number } {
  if (!existsSync(dbPath)) throw new Error(`Meetily's database was not found at ${dbPath}. Is Meetily installed?`);
  const since = Date.parse(o.sinceIso);
  if (!Number.isFinite(since)) throw new Error("the sync start time is not a date");

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: o.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    const rows = db.prepare(`SELECT id, title, created_at, updated_at FROM ${MEETINGS} ORDER BY created_at`).all() as unknown as MeetingRow[];
    const lines = db.prepare(`SELECT transcript, audio_start_time, audio_end_time, speaker FROM ${TRANSCRIPTS} WHERE meeting_id = ? ORDER BY audio_start_time IS NULL, audio_start_time, rowid`);
    const summary = db.prepare(`SELECT result FROM ${SUMMARIES} WHERE meeting_id = ?`);

    const meetings: RawMeeting[] = [];
    for (const r of rows) {
      const created = Date.parse(r.created_at);
      const updated = Date.parse(r.updated_at);
      if (!Number.isFinite(created) || created < since || o.skipIds.has(r.id)) continue;
      if (Number.isFinite(updated) && o.now.getTime() - updated < STILL_RECORDING_MS) continue;

      const transcriptRows = lines.all(r.id) as unknown as LineRow[];
      let lastEndSec = -Infinity;
      for (const l of transcriptRows) if (typeof l.audio_end_time === "number" && l.audio_end_time > lastEndSec) lastEndSec = l.audio_end_time;
      const end = Number.isFinite(lastEndSec) ? created + lastEndSec * 1000 : Number.isFinite(updated) ? updated : created;

      meetings.push({
        meetilyId: r.id,
        title: r.title?.trim() || "Untitled meeting",
        startedAt: new Date(created).toISOString(),
        endedAt: new Date(Math.max(end, created)).toISOString(),
        notes: noteOf((summary.get(r.id) as unknown as SummaryRow | undefined)?.result),
        transcript: transcriptRows.map((l) => ({
          speaker: l.speaker?.trim() ? l.speaker : null,
          atSec: typeof l.audio_start_time === "number" ? l.audio_start_time : null,
          text: l.transcript ?? "",
        })),
      });
    }
    return { meetings, scanned: meetings.length };
  } catch (e) {
    if (isBusy(e)) throw new Error("Meetily is busy with its database (it may be recording or saving). Try again in a minute.");
    throw new Error("Meetily's database could not be read. Close Meetily and try again.", { cause: e });
  } finally {
    db?.close();
  }
}
