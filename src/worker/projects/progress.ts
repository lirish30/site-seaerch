import { dayKey } from "../booking/slots";
import { businessesAwaitingChangeOrderPayment } from "../db/changeOrders";
import { listProjects, projectIsLive } from "../db/projects";
import { getSettings } from "../db/settings";
import { cappedStepCountsByBusiness, listOpenTasksForLogan, listTasks, reviewCountsByBusiness, type Task } from "../db/tasks";
import { cleanText } from "../onboarding/templates";
import { MAX_AUTO_RETRIES, SOP_STEP_KIND } from "../queue/sopStep";
import { zoneOf } from "../sop/cadence";
import { unmetRequirements } from "../sop/model";
import { currentPhase, phaseOrder } from "../sop/ready";

const DAY = 86_400_000;
const DONE_DAYS = 7, DONE_MAX = 5, NEXT_MAX = 3, LINE_MAX = 120;

const finished = (t: Task) => t.status === "done" || t.status === "skipped";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A client summary as one clean line (it was typed by Logan or copied from a template, so it is cleaned before it can go into a mail); empty when nothing is left. */
const summaryOf = (t: Task) => cleanText(t.clientSummary ?? "", LINE_MAX).replace(/\s+/g, " ").trim();

/**
 * What the client may be told about their project: `done` is what finished in the last 7 days (newest first, at most 5), `next` what comes next in each project's current phase
 * (the earliest unfinished, at most 3). Only a task with a client summary is ever listed, and the line is the summary, never the task's own title, so internal work stays internal.
 * A lead's test projects and cancelled ones give nothing; a finished project still lists what it finished this week. `_tz` is part of the shape the Friday mail passes: the window is
 * an elapsed 7 days, which needs no time zone.
 */
export async function projectDoneNext(db: D1Database, businessId: string, now: Date, _tz: string): Promise<{ done: string[]; next: string[] }> {
  const projects = (await listProjects(db, { businessId, status: ["active", "done"] })).filter((p) => !p.test).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const since = now.getTime() - DONE_DAYS * DAY;
  const done: { at: number; line: string }[] = [];
  const next: string[] = [];
  for (const p of projects) {
    const tasks = await listTasks(db, p.id);
    for (const t of tasks) {
      const at = t.doneAt ? Date.parse(t.doneAt) : NaN;
      if (t.status === "done" && Number.isFinite(at) && at >= since && summaryOf(t)) done.push({ at, line: summaryOf(t) });
    }
    if (!projectIsLive(p)) continue;
    const phase = currentPhase(tasks), order = phaseOrder(tasks);
    if (phase === null) continue;
    for (const t of tasks) if (t.isStep && !finished(t) && t.status !== "locked" && order.get(t.phaseKey) === phase && summaryOf(t)) next.push(summaryOf(t));
  }
  return { done: done.sort((a, b) => b.at - a.at).slice(0, DONE_MAX).map((d) => d.line), next: next.slice(0, NEXT_MAX) };
}

/**
 * What needs the owner on each lead's real, active projects, for Today: one reason per lead, the first that applies. (1) Claude's drafts waiting for review, (2) Claude steps that automatic
 * dispatch gave up on (`MAX_AUTO_RETRIES` jobs failed or expired; they would otherwise sit silent), (3) a signed change order not paid yet, (4) Logan's ready tasks that are overdue or due today
 * in the booking time zone. Test projects and change orders never count.
 */
export async function projectAttention(db: D1Database, now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const review = await reviewCountsByBusiness(db);
  const capped = await cappedStepCountsByBusiness(db, SOP_STEP_KIND, MAX_AUTO_RETRIES);
  const unpaid = await businessesAwaitingChangeOrderPayment(db);
  for (const [id, n] of review) out.set(id, `${plural(n, "Claude step")} to review`);
  for (const [id, n] of capped) if (!out.has(id)) out.set(id, n === 1 ? "1 Claude step needs you" : `${n} Claude steps need you`);
  for (const id of unpaid) if (!out.has(id)) out.set(id, "Change order signed: waiting for payment");

  const today = dayKey(now.getTime(), zoneOf(await getSettings(db)));
  const due = (await listOpenTasksForLogan(db, { realOnly: true })).filter((t) => t.owner === "logan" && t.dueOn !== null && t.dueOn <= today && !out.has(t.businessId));
  const all = new Map<string, Task[]>();
  const counts = new Map<string, number>();
  for (const t of due) {
    // A to-do task is Logan's only once everything it waits on is done; one he has started is his regardless (the same rule as his own task list).
    if (t.status === "todo") {
      if (!all.has(t.projectId)) all.set(t.projectId, await listTasks(db, t.projectId));
      if (unmetRequirements(t.requires, all.get(t.projectId)!).length) continue;
    }
    counts.set(t.businessId, (counts.get(t.businessId) ?? 0) + 1);
  }
  for (const [id, n] of counts) out.set(id, `${plural(n, "task")} due`);
  return out;
}
