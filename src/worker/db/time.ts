import { cleanText } from "../onboarding/templates";

/** The request cannot be done in the state time is in: a timer already running, a task that is closed, an invoiced entry, a number out of range. The message is a plain sentence. */
export class TimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeStateError";
  }
}

export interface TimeEntry {
  id: string; taskId: string; projectId: string; businessId: string; startedAt: string; endedAt: string | null; minutes: number; billable: boolean; note: string;
  source: "timer" | "manual"; invoicedRef: string | null; createdAt: string;
}
/** An entry about to be inserted. A manual entry always has an `endedAt` (the table refuses one without). */
export type NewEntry = Omit<TimeEntry, "id" | "createdAt" | "invoicedRef">;

interface Row {
  id: string; task_id: string; project_id: string; business_id: string; started_at: string; ended_at: string | null; minutes: number; billable: number; note: string;
  source: "timer" | "manual"; invoiced_ref: string | null; created_at: string;
}

const toEntry = (r: Row): TimeEntry => ({
  id: r.id, taskId: r.task_id, projectId: r.project_id, businessId: r.business_id, startedAt: r.started_at, endedAt: r.ended_at, minutes: r.minutes, billable: !!r.billable,
  note: r.note, source: r.source, invoicedRef: r.invoiced_ref, createdAt: r.created_at,
});

/** The longest note kept. */
export const NOTE_MAX = 500;
const cleanNote = (s: string) => cleanText(s, NOTE_MAX);

export async function getEntry(db: D1Database, id: string): Promise<TimeEntry | null> {
  const r = await db.prepare(`SELECT * FROM time_entries WHERE id = ?`).bind(id).first<Row>();
  return r ? toEntry(r) : null;
}

/** The timer that is running now, or null. There is at most one (a unique index allows a single entry with no end). */
export async function runningEntry(db: D1Database): Promise<TimeEntry | null> {
  const r = await db.prepare(`SELECT * FROM time_entries WHERE ended_at IS NULL AND source = 'timer'`).first<Row>();
  return r ? toEntry(r) : null;
}

const insertStatement = (db: D1Database, id: string, e: NewEntry, createdAt: string) => db.prepare(
  `INSERT INTO time_entries (id, task_id, project_id, business_id, started_at, ended_at, minutes, billable, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(id, e.taskId, e.projectId, e.businessId, e.startedAt, e.endedAt, e.minutes, e.billable ? 1 : 0, cleanNote(e.note), e.source, createdAt);

/** Inserts one entry. A second running timer, or a manual entry with no end, is refused by the table and throws. */
export async function insertEntry(db: D1Database, e: NewEntry): Promise<TimeEntry> {
  const id = crypto.randomUUID();
  await insertStatement(db, id, e, new Date().toISOString()).run();
  return (await getEntry(db, id))!;
}

export async function listEntriesForTask(db: D1Database, taskId: string): Promise<TimeEntry[]> {
  return (await db.prepare(`SELECT * FROM time_entries WHERE task_id = ? ORDER BY started_at, rowid`).bind(taskId).all<Row>()).results.map(toEntry);
}

/** Entries that started in [fromIso, toIso), oldest first, with the task title and project name. */
export async function listEntriesBetween(db: D1Database, fromIso: string, toIso: string): Promise<(TimeEntry & { title: string; projectName: string })[]> {
  const rows = (await db.prepare(
    `SELECT e.*, t.title AS title, p.name AS project_name FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = e.project_id
     WHERE e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at, e.rowid`,
  ).bind(fromIso, toIso).all<Row & { title: string; project_name: string }>()).results;
  return rows.map((r) => ({ ...toEntry(r), title: r.title, projectName: r.project_name }));
}

/** What Logan can change on an entry. A field left out is not touched. Moving `startedAt` moves `endedAt` with it, so the length stays; changing `minutes` puts `endedAt` that long after the start. */
export interface EntryPatch { minutes?: number; billable?: boolean; note?: string; startedAt?: string }

const INVOICED = "This time has been invoiced, so it cannot be changed.";

/**
 * Applies the patch and returns the entry. Refuses (TimeStateError, nothing saved) an entry that has been invoiced (checked in the statement itself),
 * a missing one, minutes that are not a whole number from 1 to 1440, minutes on a timer that is still running, and a start that is not a date.
 */
export async function patchEntry(db: D1Database, id: string, p: EntryPatch): Promise<TimeEntry> {
  const entry = await getEntry(db, id);
  if (!entry) throw new TimeStateError("There is no such time entry.");
  if (entry.invoicedRef) throw new TimeStateError(INVOICED);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
  if (p.minutes !== undefined) {
    if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 1440) throw new TimeStateError("Minutes must be a whole number from 1 to 1440.");
    if (entry.endedAt === null) throw new TimeStateError("A timer's minutes are set when it stops.");
    set("minutes", p.minutes);
  }
  if (p.billable !== undefined) set("billable", p.billable ? 1 : 0);
  if (p.note !== undefined) set("note", cleanNote(p.note));
  // The end follows the start and the length: a new start shifts it, and new minutes put it exactly that long after the (new) start.
  let startMs = Date.parse(entry.startedAt);
  let endedAt = entry.endedAt;
  if (p.startedAt !== undefined) {
    const to = Date.parse(p.startedAt);
    if (!/^\d{4}-\d\d-\d\dT/.test(p.startedAt) || !Number.isFinite(to)) throw new TimeStateError("A start time must be a date and time like 2026-12-03T17:00:00.000Z.");
    set("started_at", new Date(to).toISOString());
    if (endedAt !== null) endedAt = new Date(Date.parse(endedAt) + (to - startMs)).toISOString();
    startMs = to;
  }
  if (p.minutes !== undefined && endedAt !== null) endedAt = new Date(startMs + p.minutes * 60_000).toISOString();
  if (endedAt !== entry.endedAt) set("ended_at", endedAt);
  if (sets.length) {
    const res = await db.prepare(`UPDATE time_entries SET ${sets.join(", ")} WHERE id = ? AND invoiced_ref IS NULL`).bind(...vals, id).run();
    if ((res.meta.changes ?? 0) !== 1) throw new TimeStateError(INVOICED);
  }
  return (await getEntry(db, id))!;
}

/** Deletes an entry. Refuses (TimeStateError) one that has been invoiced, checked in the statement itself; a missing entry is already gone. */
export async function deleteEntry(db: D1Database, id: string): Promise<void> {
  const res = await db.prepare(`DELETE FROM time_entries WHERE id = ? AND invoiced_ref IS NULL`).bind(id).run();
  if ((res.meta.changes ?? 0) === 1) return;
  if (await getEntry(db, id)) throw new TimeStateError(INVOICED);
}

/** Minutes logged on a task or project (or on everything, with neither), and the part of them that is billable. A running timer counts for 0 until it stops. */
export async function timeTotals(db: D1Database, o: { taskId?: string; projectId?: string }): Promise<{ actualMinutes: number; billableMinutes: number }> {
  const where: string[] = [], binds: string[] = [];
  if (o.taskId !== undefined) { where.push("task_id = ?"); binds.push(o.taskId); }
  if (o.projectId !== undefined) { where.push("project_id = ?"); binds.push(o.projectId); }
  const r = await db.prepare(
    `SELECT COALESCE(SUM(minutes), 0) AS actual, COALESCE(SUM(CASE WHEN billable = 1 THEN minutes ELSE 0 END), 0) AS billable FROM time_entries${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
  ).bind(...binds).first<{ actual: number; billable: number }>();
  return { actualMinutes: r?.actual ?? 0, billableMinutes: r?.billable ?? 0 };
}

/** How the running timer ends: saved with its length, or dropped (too short to count). */
export type StopPlan = { id: string; endedAt: string; minutes: number; note: string } | { id: string; drop: true };

/**
 * Ends the running timer (when `stop` is given) and starts a new one (when `start` is) in ONE batch, so the one-running-timer index never sees two.
 * The stop is guarded in the statement (it only touches an entry that is still running). If another start got there first the batch fails whole
 * and this throws TimeStateError. Returns the stopped entry (null when it was dropped or there was none) and the new one.
 */
export async function commitTimer(db: D1Database, o: { stop: StopPlan | null; start: NewEntry | null }): Promise<{ stopped: TimeEntry | null; started: TimeEntry | null }> {
  const stmts: D1PreparedStatement[] = [];
  const { stop } = o;
  if (stop) {
    stmts.push("drop" in stop
      ? db.prepare(`DELETE FROM time_entries WHERE id = ? AND ended_at IS NULL`).bind(stop.id)
      : db.prepare(`UPDATE time_entries SET ended_at = ?, minutes = ?, note = ? WHERE id = ? AND ended_at IS NULL`).bind(stop.endedAt, stop.minutes, cleanNote(stop.note), stop.id));
  }
  const startId = crypto.randomUUID();
  if (o.start) stmts.push(insertStatement(db, startId, o.start, new Date().toISOString()));
  if (!stmts.length) return { stopped: null, started: null };
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String(e instanceof Error ? `${e.message} ${e.cause ?? ""}` : e))) throw new TimeStateError("Another timer is already running.");
    throw e;
  }
  return {
    stopped: stop && !("drop" in stop) ? await getEntry(db, stop.id) : null,
    started: o.start ? await getEntry(db, startId) : null,
  };
}
