import { MeetingSummarySchema, type MeetingSummary } from "../meetings/summary";

export type MeetingStatus = "received" | "summarized" | "failed";

export interface Meeting {
  id: string; meetilyId: string; businessId: string; bookingId: string | null; windowKey: string; title: string; startedAt: string; endedAt: string;
  transcriptKey: string; notes: string | null; status: MeetingStatus; summary: MeetingSummary | null; followupSentAt: string | null; createdAt: string; summarizedAt: string | null;
}

/** What a caller gives to record a meeting; the status and timestamps are set here. `id` is optional: a caller whose transcript key names the meeting picks it first (a repeat keeps the first row's id). */
export type NewMeeting = Pick<Meeting, "meetilyId" | "businessId" | "bookingId" | "windowKey" | "title" | "startedAt" | "endedAt" | "transcriptKey" | "notes"> & { id?: string };

interface Row {
  id: string; meetily_id: string; business_id: string; booking_id: string | null; window_key: string; title: string; started_at: string; ended_at: string;
  transcript_key: string; notes: string | null; status: MeetingStatus; summary: string | null; followup_sent_at: string | null; created_at: string; summarized_at: string | null;
}

/** The summary column read back; a missing, damaged or wrongly shaped value is `null`, never a thrown error. */
function readSummary(s: string | null): MeetingSummary | null {
  if (s === null) return null;
  try {
    const v = MeetingSummarySchema.safeParse(JSON.parse(s));
    return v.success ? v.data : null;
  } catch { return null; }
}

const toMeeting = (r: Row): Meeting => ({
  id: r.id, meetilyId: r.meetily_id, businessId: r.business_id, bookingId: r.booking_id, windowKey: r.window_key, title: r.title, startedAt: r.started_at, endedAt: r.ended_at,
  transcriptKey: r.transcript_key, notes: r.notes, status: r.status, summary: readSummary(r.summary), followupSentAt: r.followup_sent_at, createdAt: r.created_at, summarizedAt: r.summarized_at,
});

export async function getMeeting(db: D1Database, id: string): Promise<Meeting | null> {
  const r = await db.prepare(`SELECT * FROM meetings WHERE id = ?`).bind(id).first<Row>();
  return r ? toMeeting(r) : null;
}

/** Records a meeting unless Meetily's id is already here, in ONE statement. `created` is true only for the call that made the row; otherwise the row that was already there comes back untouched. */
export async function insertMeetingIfNew(db: D1Database, m: NewMeeting): Promise<{ meeting: Meeting; created: boolean }> {
  const id = m.id ?? crypto.randomUUID();
  const res = await db.prepare(
    `INSERT INTO meetings (id, meetily_id, business_id, booking_id, window_key, title, started_at, ended_at, transcript_key, notes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'received', ?)
     ON CONFLICT(meetily_id) DO NOTHING`,
  ).bind(id, m.meetilyId, m.businessId, m.bookingId, m.windowKey, m.title, m.startedAt, m.endedAt, m.transcriptKey, m.notes, new Date().toISOString()).run();
  const created = (res.meta.changes ?? 0) === 1;
  const row = (await db.prepare(`SELECT * FROM meetings WHERE meetily_id = ?`).bind(m.meetilyId).first<Row>())!;
  return { meeting: toMeeting(row), created };
}

/** The meeting recorded for Meetily's id, if any. */
export async function meetingByMeetilyId(db: D1Database, meetilyId: string): Promise<Meeting | null> {
  const r = await db.prepare(`SELECT * FROM meetings WHERE meetily_id = ?`).bind(meetilyId).first<Row>();
  return r ? toMeeting(r) : null;
}

/** Newest first. Pass `businessId` for one client's meetings. */
export async function listMeetings(db: D1Database, o: { businessId?: string; limit?: number }): Promise<Meeting[]> {
  const rows = o.businessId
    ? (await db.prepare(`SELECT * FROM meetings WHERE business_id = ? ORDER BY started_at DESC, id LIMIT ?`).bind(o.businessId, o.limit ?? 50).all<Row>()).results
    : (await db.prepare(`SELECT * FROM meetings ORDER BY started_at DESC, id LIMIT ?`).bind(o.limit ?? 50).all<Row>()).results;
  return rows.map(toMeeting);
}

/** Meetily ids of the meetings that started at or after `sinceIso`: what the pull already has, so it can skip them. */
export async function knownMeetilyIds(db: D1Database, sinceIso: string): Promise<string[]> {
  return (await db.prepare(`SELECT meetily_id FROM meetings WHERE started_at >= ?`).bind(sinceIso).all<{ meetily_id: string }>()).results.map((r) => r.meetily_id);
}

/** Stores the summary and marks the meeting summarized. True only for the call that moved a received or failed meeting to summarized. */
export async function saveSummary(db: D1Database, id: string, s: MeetingSummary, now: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE meetings SET status = 'summarized', summary = ?, summarized_at = ? WHERE id = ? AND status IN ('received', 'failed')`).bind(JSON.stringify(s), now, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Marks a meeting that was never summarized as failed, so the panel offers "Summarize again". True only for the call that moved a received meeting; a summarized one is left alone. */
export async function setMeetingFailed(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE meetings SET status = 'failed' WHERE id = ? AND status = 'received'`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Records that the follow-up email went out. True only the first time, so it is never sent twice. */
export async function markFollowupSent(db: D1Database, id: string, now: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE meetings SET followup_sent_at = ? WHERE id = ? AND followup_sent_at IS NULL`).bind(now, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** The meeting held for this booking, if one was recorded. */
export async function meetingForBooking(db: D1Database, bookingId: string): Promise<Meeting | null> {
  const r = await db.prepare(`SELECT * FROM meetings WHERE booking_id = ? ORDER BY started_at DESC LIMIT 1`).bind(bookingId).first<Row>();
  return r ? toMeeting(r) : null;
}
