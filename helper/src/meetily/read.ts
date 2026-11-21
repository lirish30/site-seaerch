import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Meetily keeps API keys and its licence in the same database file. These three tables are the only ones this helper ever names; no query
 * below mentions any other table, so a key cannot reach an upload or a log line.
 */
const MEETINGS = "meetings";
const TRANSCRIPTS = "transcripts";
const SUMMARIES = "summary_processes";

/** A meeting touched this recently (its record, its summary or its audio) is probably still being recorded, so it is left for the next sync. */
const STILL_RECORDING_MS = 5 * 60_000;
/** With no summary row at all, wait this long after the meeting ended before sending it without notes. */
const NO_SUMMARY_WAIT_MS = 30 * 60_000;
/** A summary still pending or processing this long after the meeting ended is stuck; send the meeting without waiting any longer. */
const SUMMARY_GIVE_UP_MS = 24 * 60 * 60_000;
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
interface SummaryRow { status: string | null; result: string | null; updated_at: string | null }

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
 * Meetings Meetily has recorded since `sinceIso`, read straight from its database and never changed (opened read-only, every read inside one
 * transaction so a meeting and its lines come from the same moment). `scanned` counts every meeting looked at: those not in `skipIds` and not
 * started before `sinceIso`. A scanned meeting is held back for the next sync (not in `meetings`) when it might not be finished:
 * - a date in its record is unreadable (fail closed);
 * - its record or its summary changed, or its audio ended, under five minutes before `now` (still recording);
 * - its summary is still being written (any status but completed or failed/error), until 24 hours after it ended;
 * - it has no summary row yet, until 30 minutes after it ended.
 * A meeting ends `max(audio_end_time)` seconds after it began, or at `updated_at` when its lines carry no end times.
 */
export function readMeetings(
  dbPath: string,
  o: { sinceIso: string; skipIds: ReadonlySet<string>; now: Date; busyTimeoutMs?: number },
): { meetings: RawMeeting[]; scanned: number } {
  if (!existsSync(dbPath)) throw new Error(`Meetily's database was not found at ${dbPath}. Is Meetily installed?`);
  const since = Date.parse(o.sinceIso);
  if (!Number.isFinite(since)) throw new Error("the sync start time is not a date");
  const now = o.now.getTime();

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: o.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    db.exec("BEGIN");
    const rows = db.prepare(`SELECT id, title, created_at, updated_at FROM ${MEETINGS} ORDER BY created_at`).all() as unknown as MeetingRow[];
    const lines = db.prepare(`SELECT transcript, audio_start_time, audio_end_time, speaker FROM ${TRANSCRIPTS} WHERE meeting_id = ? ORDER BY audio_start_time IS NULL, audio_start_time, rowid`);
    const summary = db.prepare(`SELECT status, result, updated_at FROM ${SUMMARIES} WHERE meeting_id = ?`);

    const meetings: RawMeeting[] = [];
    let scanned = 0;
    for (const r of rows) {
      if (o.skipIds.has(r.id)) continue;
      const created = Date.parse(r.created_at);
      if (Number.isFinite(created) && created < since) continue;
      scanned++;
      const updated = Date.parse(r.updated_at);
      if (!Number.isFinite(created) || !Number.isFinite(updated)) continue;

      const sum = summary.get(r.id) as unknown as SummaryRow | undefined;
      const summaryUpdated = sum?.updated_at ? Date.parse(sum.updated_at) : NaN;
      const lastTouched = Math.max(updated, Number.isFinite(summaryUpdated) ? summaryUpdated : -Infinity);
      if (now - lastTouched < STILL_RECORDING_MS) continue;

      const transcriptRows = lines.all(r.id) as unknown as LineRow[];
      let lastEndSec = -Infinity;
      for (const l of transcriptRows) if (typeof l.audio_end_time === "number" && l.audio_end_time > lastEndSec) lastEndSec = l.audio_end_time;
      const end = Math.max(Number.isFinite(lastEndSec) ? created + lastEndSec * 1000 : updated, created);
      const sinceEnd = now - end;
      if (sinceEnd < STILL_RECORDING_MS) continue;

      const status = sum?.status?.trim().toLowerCase() ?? null;
      const notes = noteOf(sum?.result);
      const summaryDone = sinceEnd >= SUMMARY_GIVE_UP_MS
        || (sum ? (status === "completed" && notes !== null) || status === "failed" || status === "error" : sinceEnd >= NO_SUMMARY_WAIT_MS);
      if (!summaryDone) continue;

      meetings.push({
        meetilyId: r.id,
        title: r.title?.trim() || "Untitled meeting",
        startedAt: new Date(created).toISOString(),
        endedAt: new Date(end).toISOString(),
        notes,
        transcript: transcriptRows.map((l) => ({
          speaker: l.speaker?.trim() ? l.speaker : null,
          atSec: typeof l.audio_start_time === "number" ? l.audio_start_time : null,
          text: l.transcript ?? "",
        })),
      });
    }
    db.exec("COMMIT");
    return { meetings, scanned };
  } catch (e) {
    if (isBusy(e)) throw new Error("Meetily is busy with its database (it may be recording or saving). Try again in a minute.");
    throw new Error("Meetily's database could not be read. Close Meetily and try again.", { cause: e });
  } finally {
    db?.close();
  }
}
