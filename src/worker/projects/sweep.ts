import { shortId } from "../changeorders/service";
import { activityStmt } from "../db/activity";
import { expireDue } from "../db/changeOrders";
import { getProject, listCadences } from "../db/projects";
import { getSettings } from "../db/settings";
import { getTemplate } from "../db/sops";
import { insertTasks, listTasks, type NewTask } from "../db/tasks";
import type { Env } from "../env";
import { cleanText } from "../onboarding/templates";
import { dueOnFor, periodKey, periodLabel, zoneOf } from "../sop/cadence";
import { OWNER_LABEL, type OwnerTag, type SopTemplate } from "../sop/model";
import { capStaleTimers } from "../time/service";
import { dispatchReady } from "./dispatch";
import { startProjectsForPaidDocuments } from "./start";

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/** Logan's if any step is his, else Claude drafting for his approval if any step is, else Claude's. */
function ownerOf(t: SopTemplate): OwnerTag {
  const owners = new Set(t.steps.map((s) => s.owner));
  return owners.has("logan") ? "logan" : owners.has("claude_drafts") ? "claude_drafts" : "claude";
}

/** The task for one period of a recurring template: its steps become the checklist, so a weekly update is one task to tick through, not a dozen. */
function recurringTask(o: { projectId: string; businessId: string; template: SopTemplate; period: string; label: string; dueOn: string; position: number }): NewTask {
  const { template } = o;
  return {
    projectId: o.projectId, businessId: o.businessId, isStep: false, stepKey: null, phaseKey: "recurring", phaseTitle: "Recurring", position: o.position,
    title: cleanText(`${template.name}: ${o.label}`, 120), description: "", owner: ownerOf(template), status: "todo", doneWhen: "", estMinutes: template.steps.reduce((n, s) => n + s.estMinutes, 0),
    dueOn: o.dueOn, billable: false, skippable: false, requires: [], milestone: null, clientSummary: null, docTemplate: null, emailTemplate: null,
    checklist: template.steps.map((s) => ({ text: `${s.title} (${OWNER_LABEL[s.owner]})`, done: false })), changeOrderId: null, cadenceKey: template.key, periodKey: o.period,
  };
}

/**
 * For every recurring template attached to an active, real project (a paused, finished, cancelled or test project gets nothing), makes the task for the period `now` falls in (a week,
 * month, quarter or year in the booking time zone) if it is not there yet. A template that is switched off or missing makes nothing. The unique index on (project, cadence, period) is what keeps
 * it to one: a rerun, or a second sweep at the same moment, adds nothing. Each cadence is tried on its own. Returns how many tasks it made.
 */
export async function generateRecurring(env: Env, now: Date): Promise<number> {
  const db = env.DB;
  const tz = zoneOf(await getSettings(db));
  const templates = new Map<string, SopTemplate | null>();
  let made = 0;
  for (const c of await listCadences(db, { activeProjectsOnly: true })) {
    try {
      const project = await getProject(db, c.projectId);
      if (!project || project.status !== "active" || project.test) continue;
      if (!templates.has(c.templateKey)) templates.set(c.templateKey, await getTemplate(db, c.templateKey));
      const template = templates.get(c.templateKey);
      if (!template || !template.active || template.kind !== "recurring" || !template.cadence) continue;
      const period = periodKey(template.cadence, now, tz);
      const tasks = await listTasks(db, project.id);
      if (tasks.some((t) => t.cadenceKey === template.key && t.periodKey === period)) continue;
      const row = recurringTask({
        projectId: project.id, businessId: project.businessId, template, period, label: periodLabel(template.cadence, period), dueOn: dueOnFor(template.cadence, template.cadenceDay, now, tz),
        position: tasks.reduce((m, t) => Math.max(m, t.position), -1) + 1,
      });
      made += (await insertTasks(db, [row], { ignoreDuplicates: true })).length;
    } catch (e) {
      console.error("projects: could not make a recurring task", msg(e));
    }
  }
  return made;
}

/** Expires the change orders whose time has run out and notes each one once on its lead (an order expires only once, so a second sweep notes nothing). Returns how many. */
async function expireChangeOrders(env: Env, now: Date): Promise<number> {
  const expired = await expireDue(env.DB, now.toISOString());
  if (expired.length) await env.DB.batch(expired.map((co) => activityStmt(env.DB, co.businessId, "change_order_void", `${co.content.reference} (${shortId(co)}) expired`.slice(0, 300))));
  return expired.length;
}

export interface ProjectSweepResult { started: number; recurring: number; dispatched: number; expired: number; stopped: number }

/**
 * The daily project sweep, in order: makes this period's recurring tasks, starts the projects a paid proposal never got (or finishes one that has no steps), sends every Claude step that
 * is ready (this is also what picks up a project that was resumed, or whose client has written since), expires change orders past their date, and saves a timer left running past its cap.
 * Each part is contained and logged, so one failing cannot stop another, and nothing here sends mail or makes an approval: Claude steps go to the queue, which is Logan's own work.
 * Returns what each part did (0 for a part that failed).
 */
export async function sweepProjects(env: Env, now: Date): Promise<ProjectSweepResult> {
  const part = async (name: string, run: () => Promise<number>): Promise<number> => {
    try { return await run(); } catch (e) { console.error(`project sweep: ${name} failed`, msg(e)); return 0; }
  };
  const recurring = await part("recurring tasks", () => generateRecurring(env, now));
  const started = await part("starting projects", () => startProjectsForPaidDocuments(env, now));
  const dispatched = await part("dispatching Claude steps", async () => (await dispatchReady(env, now)).queued);
  const expired = await part("expiring change orders", () => expireChangeOrders(env, now));
  const stopped = await part("stopping a stale timer", () => capStaleTimers(env, now));
  return { started, recurring, dispatched, expired, stopped };
}
