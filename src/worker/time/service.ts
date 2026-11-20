import type { Env } from "../env";
import { dayKey, wallToUtc } from "../booking/slots";
import { parseConfig } from "../booking/config";
import { commitTimer, getEntry, insertEntry, listEntriesBetween, runningEntry, TimeStateError, type StopPlan, type TimeEntry } from "../db/time";
import { getSettings } from "../db/settings";
import { getTask } from "../db/tasks";
import { parseWorkConfig } from "./config";

export { TimeStateError };

const MIN = 60_000;
/** A timer shorter than this is a mis-click, not work: it is dropped. */
const DROP_BELOW_MS = 30_000;
const CAP_NOTE = "stopped at the cap";

/** How a running timer ends at `nowMs`: dropped under 30 seconds, saved at the cap when it ran past it, otherwise rounded to the nearest minute. */
function planStop(running: TimeEntry, nowMs: number, capMinutes: number, note: string): StopPlan {
  const startMs = Date.parse(running.startedAt);
  const elapsed = nowMs - startMs;
  if (elapsed < DROP_BELOW_MS) return { id: running.id, drop: true };
  if (elapsed > capMinutes * MIN) {
    return { id: running.id, endedAt: new Date(startMs + capMinutes * MIN).toISOString(), minutes: capMinutes, note: note ? `${note}; ${CAP_NOTE}` : CAP_NOTE };
  }
  return { id: running.id, endedAt: new Date(nowMs).toISOString(), minutes: Math.round(elapsed / MIN), note };
}

async function capMinutesOf(db: D1Database): Promise<number> {
  return parseWorkConfig((await getSettings(db)).work_config).timerCapMinutes;
}

/**
 * Starts a timer on a task and stops any running one first, in the same batch (the unique index never sees two). `stopped` is the timer that was saved
 * (null when none was running or it was under 30 seconds and dropped). A task that is done, skipped or locked takes no timer: nothing changes.
 */
export async function startTimer(env: Pick<Env, "DB">, taskId: string, now: Date): Promise<{ entry: TimeEntry; stopped: TimeEntry | null }> {
  const task = await getTask(env.DB, taskId);
  if (!task) throw new TimeStateError("There is no such task.");
  if (task.status === "done" || task.status === "skipped" || task.status === "locked") {
    throw new TimeStateError(`A ${task.status} task cannot be timed.`);
  }
  const running = await runningEntry(env.DB);
  const stop = running ? planStop(running, now.getTime(), await capMinutesOf(env.DB), running.note) : null;
  const { stopped, started } = await commitTimer(env.DB, {
    stop,
    start: { taskId, projectId: task.projectId, businessId: task.businessId, startedAt: now.toISOString(), endedAt: null, minutes: 0, billable: task.billable, note: "", source: "timer" },
  });
  return { entry: started!, stopped };
}

async function stopRunning(db: D1Database, now: Date, o: { note?: string; onlyTaskId?: string }): Promise<TimeEntry | null> {
  const running = await runningEntry(db);
  if (!running || (o.onlyTaskId !== undefined && running.taskId !== o.onlyTaskId)) return null;
  const plan = planStop(running, now.getTime(), await capMinutesOf(db), o.note ?? running.note);
  return (await commitTimer(db, { stop: plan, start: null })).stopped;
}

/**
 * Stops the running timer. Minutes are the time elapsed to the nearest minute; under 30 seconds the entry is deleted and null comes back
 * (as it does when nothing was running); past the cap in settings it is saved at the cap with the note "stopped at the cap".
 */
export function stopTimer(env: Pick<Env, "DB">, now: Date, o: { note?: string } = {}): Promise<TimeEntry | null> {
  return stopRunning(env.DB, now, { note: o.note });
}

/** Stops the running timer only if it is on this task (a task finished or skipped stops its own timer, and no one else's). */
export function stopTimerFor(db: D1Database, taskId: string, now: Date): Promise<TimeEntry | null> {
  return stopRunning(db, now, { onlyTaskId: taskId });
}

/** For the cron: saves a timer that has run past the cap (left on over a weekend) at the cap. Returns how many were stopped (0 or 1). */
export async function capStaleTimers(env: Pick<Env, "DB">, now: Date): Promise<number> {
  const running = await runningEntry(env.DB);
  if (!running) return 0;
  if (now.getTime() - Date.parse(running.startedAt) <= (await capMinutesOf(env.DB)) * MIN) return 0;
  return (await stopRunning(env.DB, now, {})) ? 1 : 0;
}

/** A real calendar date: "2026-13-01" and "2026-02-30" are not (the second would roll into March). */
const isCalendarDate = (s: string) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
};
const utcMidnight = (day: string) => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (day: string, n: number) => new Date(utcMidnight(day) + n * 86_400_000).toISOString().slice(0, 10);
const zoneNow = async (db: D1Database) => parseConfig((await getSettings(db)).booking_config).timezone;

/**
 * Time typed in after the fact. `minutes` is a whole number from 1 to 1440, `day` is a calendar date no later than today in the booking time zone,
 * and the task is not locked (a done task is fine: time often gets logged after the work). The entry starts at noon of `day` in the zone and ends
 * `minutes` later, so it always has an end and never takes the running-timer slot. Billable defaults to the task's flag.
 */
export async function addManualEntry(
  env: Pick<Env, "DB">, o: { taskId: string; day: string; minutes: number; billable?: boolean; note?: string }, now: Date,
): Promise<TimeEntry> {
  if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > 1440) throw new TimeStateError("Minutes must be a whole number from 1 to 1440.");
  if (!isCalendarDate(o.day)) throw new TimeStateError("A day must be a real date like 2026-12-03.");
  const task = await getTask(env.DB, o.taskId);
  if (!task) throw new TimeStateError("There is no such task.");
  if (task.status === "locked") throw new TimeStateError("A locked task cannot take time yet.");
  const tz = await zoneNow(env.DB);
  if (o.day > dayKey(now.getTime(), tz)) throw new TimeStateError("Time cannot be logged on a day that has not come yet.");
  const startMs = wallToUtc(utcMidnight(o.day), 720, tz, true) ?? utcMidnight(o.day) + 12 * 3_600_000;
  return insertEntry(env.DB, {
    taskId: task.id, projectId: task.projectId, businessId: task.businessId, startedAt: new Date(startMs).toISOString(), endedAt: new Date(startMs + o.minutes * MIN).toISOString(),
    minutes: o.minutes, billable: o.billable ?? task.billable, note: o.note ?? "", source: "manual",
  });
}

export interface WeekGrid {
  /** Seven calendar dates, the first being the week's start day. */
  days: string[];
  rows: { taskId: string; projectId: string; projectName: string; title: string; minutes: number[]; total: number }[];
  dayTotals: number[];
  total: number;
}

/**
 * The timesheet for the week containing `weekOf` (a calendar date), starting on Sunday or Monday. An entry sits in the day its start falls on in `tz`.
 * The days are counted as calendar dates, so a week with a clock change still has seven. A timer that is still running has no minutes yet and is left out.
 * Rows are sorted by project then task title.
 */
export async function weekGrid(db: D1Database, o: { weekOf: string; tz: string; weekStartsOn: 0 | 1 }): Promise<WeekGrid> {
  if (!isCalendarDate(o.weekOf)) throw new TimeStateError("A week must be given as a real date like 2026-12-03.");
  const back = (new Date(utcMidnight(o.weekOf)).getUTCDay() - o.weekStartsOn + 7) % 7;
  const first = addDays(o.weekOf, -back);
  const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  const from = wallToUtc(utcMidnight(first), 0, o.tz, true) ?? utcMidnight(first);
  const to = wallToUtc(utcMidnight(addDays(first, 7)), 0, o.tz, true) ?? utcMidnight(addDays(first, 7));
  const entries = await listEntriesBetween(db, new Date(from).toISOString(), new Date(to).toISOString());
  const byTask = new Map<string, WeekGrid["rows"][number]>();
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const e of entries) {
    if (e.endedAt === null) continue;
    const i = days.indexOf(dayKey(Date.parse(e.startedAt), o.tz));
    if (i < 0) continue;
    let row = byTask.get(e.taskId);
    if (!row) { row = { taskId: e.taskId, projectId: e.projectId, projectName: e.projectName, title: e.title, minutes: [0, 0, 0, 0, 0, 0, 0], total: 0 }; byTask.set(e.taskId, row); }
    row.minutes[i] += e.minutes;
    row.total += e.minutes;
    dayTotals[i] += e.minutes;
  }
  const rows = [...byTask.values()].sort((a, b) => a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId));
  return { days, rows, dayTotals, total: dayTotals.reduce((a, b) => a + b, 0) };
}
