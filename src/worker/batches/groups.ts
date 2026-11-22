import { heldBusinessIds } from "../db/holds";
import { getGrades, type Grade } from "../db/grade";
import { liveProjectSql } from "../db/projects";
import { getSettings } from "../db/settings";
import { listTemplates } from "../db/sops";
import { dueOnFor, periodKey, periodLabel, zoneOf } from "../sop/cadence";
import type { Cadence, TaskStatus } from "../sop/model";

/** One client's task in a batch: the checklist is only counted here, never listed. `held` marks a client with a billing hold (shown, not hidden: their work waits). */
export interface BatchTask {
  taskId: string; businessId: string; client: string; grade: Grade | null; status: TaskStatus; dueOn: string | null; estMinutes: number;
  checklistDone: number; checklistTotal: number; held: boolean;
}
/**
 * One recurring template in one period, across clients. `open` is the tasks still to do (not done and not skipped), `done` the finished ones, and `estMinutes` the estimate left on the open ones.
 * A skipped task is listed (so the row is not a mystery) but is neither open nor done and adds no minutes.
 */
export interface BatchGroup {
  templateKey: string; name: string; cadence: Cadence; period: string; label: string; dueOn: string | null; open: number; done: number; estMinutes: number; tasks: BatchTask[];
}

interface Row { id: string; business_id: string; client: string; status: TaskStatus; due_on: string | null; est_minutes: number; checklist: string; period_key: string }

const DAY = 86_400_000;
/** A `YYYY-MM-DD` date moved by whole days. */
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * The period just before the one `now` is in, as its key. The period's first day (a Monday, the 1st, the first of the quarter or the year) minus one day is a calendar date in the earlier period;
 * that date is read as noon UTC in the UTC zone so the booking zone cannot move it to another day.
 */
export function previousPeriodKey(c: Cadence, now: Date, tz: string): string {
  const lastDayBefore = addDays(dueOnFor(c, 1, now, tz), -1);
  return periodKey(c, new Date(`${lastDayBefore}T12:00:00Z`), "UTC");
}

const checklistCounts = (s: string): { done: number; total: number } => {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return { done: 0, total: 0 };
    const items = v.filter((x) => x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string");
    return { done: items.filter((x) => (x as { done?: unknown }).done === true).length, total: items.length };
  } catch { return { done: 0, total: 0 }; }
};

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2 };
const gradeRank = (g: Grade | null): number => (g === null ? 3 : GRADE_RANK[g]);
const isOpen = (s: TaskStatus): boolean => s !== "done" && s !== "skipped";

/**
 * The batch board: for each active recurring template, the tasks of its current period across every client (the period is a week, month, quarter or year counted on the calendar of the booking zone,
 * so it rolls at that zone's midnight, not UTC's), plus the previous period only while it still has an open task. Only live, real clients' projects count (the filter `generateRecurring` uses: a
 * paused, cancelled or test project is absent). A client with a billing hold is listed with `held: true`. Tasks are ordered grade A first, then B, C and no grade, then client name; groups by their
 * earliest due date (no date last), then name. A template with no task in a period has no group for it.
 */
export async function listBatches(db: D1Database, now: Date): Promise<BatchGroup[]> {
  const tz = zoneOf(await getSettings(db));
  const templates = (await listTemplates(db)).filter((t) => t.kind === "recurring" && t.cadence !== null);
  const found: { group: BatchGroup; rows: Row[] }[] = [];
  const businessIds = new Set<string>();

  for (const t of templates) {
    const cadence = t.cadence as Cadence;
    const current = periodKey(cadence, now, tz);
    const previous = previousPeriodKey(cadence, now, tz);
    const rows = (await db.prepare(
      `SELECT k.id, k.business_id, b.name AS client, k.status, k.due_on, k.est_minutes, k.checklist, k.period_key
       FROM tasks k JOIN projects p ON p.id = k.project_id JOIN businesses b ON b.id = k.business_id
       WHERE k.cadence_key = ? AND k.period_key IN (?, ?) AND ${liveProjectSql("p")} AND p.test = 0`,
    ).bind(t.key, current, previous).all<Row>()).results;
    for (const period of [current, previous]) {
      const mine = rows.filter((r) => r.period_key === period);
      if (mine.length === 0 || (period === previous && !mine.some((r) => isOpen(r.status)))) continue;
      for (const r of mine) businessIds.add(r.business_id);
      const dues = mine.map((r) => r.due_on).filter((d): d is string => d !== null).sort();
      found.push({
        rows: mine,
        group: {
          templateKey: t.key, name: t.name, cadence, period, label: periodLabel(cadence, period), dueOn: dues[0] ?? null,
          open: mine.filter((r) => isOpen(r.status)).length, done: mine.filter((r) => r.status === "done").length,
          estMinutes: mine.filter((r) => isOpen(r.status)).reduce((n, r) => n + r.est_minutes, 0), tasks: [],
        },
      });
    }
  }

  const ids = [...businessIds];
  const held = new Set<string>();
  // One statement per 50 clients keeps clear of the bound-parameter limit.
  for (let i = 0; i < ids.length; i += 50) for (const id of await heldBusinessIds(db, ids.slice(i, i + 50))) held.add(id);
  const grades = await getGrades(db, ids);

  for (const { group, rows } of found) {
    group.tasks = rows.map((r): BatchTask => {
      const c = checklistCounts(r.checklist);
      return {
        taskId: r.id, businessId: r.business_id, client: r.client, grade: grades.get(r.business_id)?.grade ?? null, status: r.status, dueOn: r.due_on, estMinutes: r.est_minutes,
        checklistDone: c.done, checklistTotal: c.total, held: held.has(r.business_id),
      };
    }).sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || a.client.localeCompare(b.client, "en", { sensitivity: "base" }) || (a.taskId < b.taskId ? -1 : 1));
  }
  const groups = found.map((f) => f.group);
  return groups.sort((a, b) => (a.dueOn ?? "9999-99-99").localeCompare(b.dueOn ?? "9999-99-99") || a.name.localeCompare(b.name) || a.period.localeCompare(b.period));
}
