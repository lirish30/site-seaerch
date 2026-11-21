import { getChangeOrder } from "../db/changeOrders";
import { addCadence, getProject, markProjectDone, reachMilestone } from "../db/projects";
import {
  addComment, CREDENTIAL_REFUSED, getTask, insertTasks, listTasks, parseTaskPatch, patchTask, setTaskStatus, TaskInputError,
  type CommentAuthor, type Task, type TaskPatch,
} from "../db/tasks";
import type { Env } from "../env";
import { cleanText, looksLikeCredential } from "../onboarding/templates";
import { findCycle, unmetRequirements, type MilestoneKey, type OwnerTag, type TaskStatus } from "../sop/model";
import { stopTimerFor } from "../time/service";
import { runMilestone, runProjectDone, runTasksChanged } from "./hooks";

/** The request cannot be done with the task (or project) as it is now: it is closed, locked, missing or changed under you. The message is a plain sentence. */
export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

/** The task cannot start or finish yet: `blockedBy` holds the titles of the steps it still waits on (a key with no task is named by the key). */
export class TaskBlockedError extends TaskStateError {
  constructor(readonly blockedBy: string[]) {
    super(`This step is waiting on: ${blockedBy.join(", ")}.`);
    this.name = "TaskBlockedError";
  }
}

/** The recurring Care templates a finished Care onboarding project starts. */
const CARE_CADENCES = ["CARE-1", "CARE-4"];
const MILESTONE_LABEL: Record<MilestoneKey, string> = { design_approved: "design approved", site_finished: "site finished" };
/** Statuses a task can be finished, skipped or marked waiting from. */
const OPEN: TaskStatus[] = ["todo", "in_progress", "in_review", "waiting_client"];
const CHANGED_UNDER_YOU = "This task changed while you were working on it. Reload and try again.";

/** True when every step is done or skipped, and there is at least one. Tasks that are not steps (ad-hoc work, change orders) never count. */
export function projectIsFinished(tasks: Task[]): boolean {
  const steps = tasks.filter((t) => t.isStep);
  return steps.length > 0 && steps.every((t) => t.status === "done" || t.status === "skipped");
}

async function need(env: Env, id: string): Promise<Task> {
  const t = await getTask(env.DB, id);
  if (!t) throw new TaskStateError("There is no such task.");
  return t;
}

/** After a status change that lost the race: the task as it is now, when it already has the status asked for, otherwise an error. */
async function lostRace(env: Env, id: string, want: TaskStatus): Promise<Task> {
  const now = await need(env, id);
  if (now.status === want) return now;
  throw new TaskStateError(CHANGED_UNDER_YOU);
}

async function checkReady(env: Env, task: Task): Promise<void> {
  if (!task.requires.length) return;
  const unmet = unmetRequirements(task.requires, await listTasks(env.DB, task.projectId));
  if (unmet.length) throw new TaskBlockedError(unmet);
}

/**
 * Brings the project in line with a step that is closed (done, or skipped when `reaches` is false): records the milestone the step marks, finishes the project when it was the last
 * open step, and attaches the Care cadences to a finished Care onboarding. Every part is idempotent and guarded in its own statement, and this runs on EVERY completion or skip,
 * replays included, so a request that died after the task was saved (or hit a database error part-way) is repaired by repeating it. A database error propagates to the caller
 * for exactly that reason. Returns true when this call changed something (so the caller knows the tasks-changed hooks are due).
 *
 * The milestone and finish statements write their timeline lines in the same batch, so each is either all there or not at all. The hooks themselves are at-most-once:
 * the call whose statement flipped the milestone or the project runs them, and a crash between that statement and the hook loses it. That is a known gap, accepted for now.
 * A hook's own error is logged and swallowed (hooks.ts).
 */
async function settle(env: Env, task: Task, now: Date, reaches: boolean): Promise<boolean> {
  const at = now.toISOString();
  let changed = false;
  let project = await getProject(env.DB, task.projectId);
  if (!project) return false;
  if (reaches && task.milestone) {
    const m = task.milestone;
    if (await reachMilestone(env.DB, project.id, m, at, { log: { businessId: project.businessId, detail: `${project.name}: ${MILESTONE_LABEL[m]}` } })) {
      changed = true;
      await runMilestone(env, project, m);
    }
  }
  let finished = false;
  if (task.isStep && projectIsFinished(await listTasks(env.DB, project.id))) {
    finished = await markProjectDone(env.DB, project.id, at, { log: { businessId: project.businessId, detail: `${project.name} finished` } });
    if (finished) { changed = true; project = (await getProject(env.DB, project.id)) ?? project; }
  }
  if (project.kind === "care_onboarding" && project.status === "done") {
    for (const key of CARE_CADENCES) if (await addCadence(env.DB, project.id, key)) changed = true;
  }
  if (finished) await runProjectDone(env, project);
  return changed;
}

/**
 * `todo`, `waiting_client` or `in_review` becomes `in_progress`. A task already under way is returned as it is. Refuses a task that is done, skipped or locked
 * (TaskStateError) and one whose requirements are not met (TaskBlockedError). The change is guarded on the status the task was read in, so two requests cannot both win.
 */
export async function startTask(env: Env, id: string, now: Date): Promise<Task> {
  const task = await need(env, id);
  if (task.status === "in_progress") return task;
  if (task.status === "done") throw new TaskStateError("This step is already done. Reopen it to work on it again.");
  if (task.status === "skipped") throw new TaskStateError("This step was skipped. Reopen it to work on it.");
  if (task.status === "locked") throw new TaskStateError("This task is locked, so it cannot be started yet.");
  await checkReady(env, task);
  if (await setTaskStatus(env.DB, id, "in_progress", { from: ["todo", "waiting_client", "in_review"], now: now.toISOString() })) return need(env, id);
  return lostRace(env, id, "in_progress");
}

/**
 * Marks the task done. Refuses a locked or skipped task and one whose requirements are not met (TaskBlockedError names them). Stops the task's own running timer.
 * Then `settle` runs: when the task has a milestone, the project reaches it (the first time only: it is logged and the milestone hooks run once); when it was the project's last
 * open step, the project is finished (once, whatever the number of requests: logs `project_done`, a Care onboarding starts its CARE-1 and CARE-4 cadences, the done hooks run).
 * The tasks-changed hooks run after a change. Completing a task that is already done runs `settle` again, so a request that died half-way is repaired by repeating it; when
 * everything is already recorded it changes and fires nothing.
 */
export async function completeTask(env: Env, id: string, o: { by: "logan" | "claude" | "system"; now: Date }): Promise<Task> {
  const task = await need(env, id);
  let moved = false;
  if (task.status !== "done") {
    if (task.status === "locked") throw new TaskStateError("This task is locked, so it cannot be finished yet.");
    if (task.status === "skipped") throw new TaskStateError("This step was skipped. Reopen it before marking it done.");
    await checkReady(env, task);
    // Before the status moves, so a failure here leaves the task as it was and a retry works.
    await stopTimerFor(env.DB, id, o.now);
    moved = await setTaskStatus(env.DB, id, "done", { from: OPEN, now: o.now.toISOString() });
    if (!moved) await lostRace(env, id, "done");
  }
  const settled = await settle(env, task, o.now, true);
  if (moved || settled) await runTasksChanged(env, task.projectId);
  return need(env, id);
}

/**
 * Skips a step with a reason (3 to 300 characters, kept as a system comment written in the same batch as the status change, so a skipped step always has its reason).
 * A skipped step satisfies `requires` only when it is marked skippable. Skipping the last open step finishes the project. Repeating a skip repairs it like `completeTask`.
 */
export async function skipTask(env: Env, id: string, reason: string, now: Date): Promise<Task> {
  const why = cleanText(reason, reason.length);
  if (why.length < 3 || why.length > 300) throw new TaskInputError("A reason for skipping is 3 to 300 characters.");
  if (looksLikeCredential(why)) throw new TaskInputError(CREDENTIAL_REFUSED);
  const task = await need(env, id);
  let moved = false;
  if (task.status !== "skipped") {
    if (task.status === "done") throw new TaskStateError("This step is already done, so it cannot be skipped.");
    if (task.status === "locked") throw new TaskStateError("This task is locked, so it cannot be skipped.");
    await stopTimerFor(env.DB, id, now);
    moved = await setTaskStatus(env.DB, id, "skipped", { from: OPEN, now: now.toISOString(), comment: { author: "system", body: `Skipped: ${why}` } });
    if (!moved) await lostRace(env, id, "skipped");
  }
  const settled = await settle(env, task, now, false);
  if (moved || settled) await runTasksChanged(env, task.projectId);
  return need(env, id);
}

/**
 * `done` or `skipped` goes back to `todo`. It never un-reaches a milestone and never reopens a finished project. A task that is already `todo` is returned as it is;
 * one under way, waiting or locked is refused.
 */
export async function reopenTask(env: Env, id: string, now: Date): Promise<Task> {
  const task = await need(env, id);
  if (task.status === "todo") return task;
  if (task.status !== "done" && task.status !== "skipped") throw new TaskStateError("Only a finished or skipped step can be reopened.");
  // A change order's task is unlocked only by its order being signed AND paid (the change-order service does that). A voided order skips its tasks: they must not come back as work.
  if (task.changeOrderId) {
    const order = await getChangeOrder(env.DB, task.changeOrderId);
    if (!order || order.status !== "signed" || order.paidAt === null) throw new TaskStateError("This task belongs to a change order that is not signed and paid, so it cannot be reopened.");
  }
  // The job and review links are cleared with the status, so a Claude job still open for this step can no longer apply its result to it.
  if (!(await setTaskStatus(env.DB, id, "todo", { from: ["done", "skipped"], now: now.toISOString(), claudeTaskId: null, reviewApprovalId: null }))) return lostRace(env, id, "todo");
  await runTasksChanged(env, task.projectId);
  return need(env, id);
}

/** Marks a task as waiting on the client (from `todo`, `in_progress` or `in_review`) or takes it off again (back to `in_progress` if it had been started, else `todo`). */
export async function setWaitingClient(env: Env, id: string, on: boolean, now: Date): Promise<Task> {
  const task = await need(env, id);
  if (on) {
    if (task.status === "waiting_client") return task;
    if (!["todo", "in_progress", "in_review"].includes(task.status)) throw new TaskStateError(`A ${task.status} task cannot be marked as waiting on the client.`);
    if (await setTaskStatus(env.DB, id, "waiting_client", { from: ["todo", "in_progress", "in_review"], now: now.toISOString() })) return need(env, id);
    return lostRace(env, id, "waiting_client");
  }
  if (task.status !== "waiting_client") return task;
  const back: TaskStatus = task.startedAt ? "in_progress" : "todo";
  if (!(await setTaskStatus(env.DB, id, back, { from: ["waiting_client"], now: now.toISOString() }))) return lostRace(env, id, back);
  await runTasksChanged(env, task.projectId);
  return need(env, id);
}

/** Refuses text that reads like a login or password. The text is cleaned the way it will be saved first, so a hidden character cannot hide it. */
function refuseCredentials(texts: (string | null | undefined)[]): void {
  for (const t of texts) if (t && looksLikeCredential(cleanText(t, t.length))) throw new TaskInputError(CREDENTIAL_REFUSED);
}

/**
 * Refuses (TaskStateError) requirements that name a step the project does not have, the task itself, or that would make steps wait on each other in a loop.
 * `self` is the step key of the task being changed (null for an ad-hoc task, which nothing can wait on).
 */
function checkRequires(tasks: Task[], self: string | null, requires: string[]): void {
  const keys = new Set<string>();
  for (const t of tasks) if (t.stepKey !== null) keys.add(t.stepKey);
  for (const r of requires) {
    if (r === self) throw new TaskStateError("A step cannot require itself.");
    if (!keys.has(r)) throw new TaskStateError(`This task requires ${r}, which is not a step in this project.`);
  }
  if (self === null) return;
  const graph = new Map<string, string[]>();
  for (const t of tasks) if (t.stepKey !== null) graph.set(t.stepKey, t.requires.filter((r) => r !== t.stepKey && keys.has(r)));
  graph.set(self, requires);
  const loop = findCycle(graph);
  if (loop) throw new TaskStateError(`Steps would wait on each other in a loop: ${loop.join(" → ")}.`);
}

/**
 * Applies a patch to a task. Text fields are refused when they read like a login or password; `requires` must name steps of the project, not the task itself, and
 * not form a loop (TaskStateError). Other bad values are a TaskInputError. A change of owner or requirements runs the tasks-changed hooks.
 */
export async function updateTask(env: Env, id: string, p: TaskPatch, now: Date): Promise<Task> {
  const task = await need(env, id);
  const v = parseTaskPatch(p);
  refuseCredentials([v.title, v.description, v.doneWhen, v.clientSummary, ...(v.checklist ?? []).map((c) => c.text)]);
  if (v.requires !== undefined) checkRequires(await listTasks(env.DB, task.projectId), task.stepKey, v.requires);
  const saved = await patchTask(env.DB, id, v, now.toISOString());
  if (v.owner !== undefined || v.requires !== undefined) await runTasksChanged(env, task.projectId);
  return saved;
}

/** Adds a task that is not one of the SOP's steps (`isStep` false, so it never finishes the project) at the end of the project. The row stamps its own times, so `_now` is only kept for the same call shape as the rest. */
export async function addAdhocTask(
  env: Env, o: { projectId: string; title: string; owner: OwnerTag; estMinutes?: number; dueOn?: string | null; billable?: boolean; requires?: string[] }, _now: Date,
): Promise<Task> {
  const project = await getProject(env.DB, o.projectId);
  if (!project) throw new TaskStateError("There is no such project.");
  if (project.status === "cancelled") throw new TaskStateError("A cancelled project cannot take new tasks.");
  const v = parseTaskPatch({ title: o.title, owner: o.owner, estMinutes: o.estMinutes ?? 0, dueOn: o.dueOn ?? null, billable: o.billable ?? false, requires: o.requires ?? [] });
  refuseCredentials([v.title]);
  const tasks = await listTasks(env.DB, o.projectId);
  checkRequires(tasks, null, v.requires!);
  const [task] = await insertTasks(env.DB, [{
    projectId: o.projectId, businessId: project.businessId, isStep: false, stepKey: null, phaseKey: "extra", phaseTitle: "Extra tasks", position: tasks.reduce((m, t) => Math.max(m, t.position), -1) + 1,
    title: v.title!, description: "", owner: v.owner!, status: "todo", doneWhen: "", estMinutes: v.estMinutes!, dueOn: v.dueOn!, billable: v.billable!, skippable: false, requires: v.requires!,
    milestone: null, clientSummary: null, docTemplate: null, emailTemplate: null, checklist: [], changeOrderId: null, cadenceKey: null, periodKey: null, editRequest: false,
  }]);
  await runTasksChanged(env, o.projectId);
  return task;
}

/** Adds a note to a task. Refused (TaskInputError, the text is never echoed) when it reads like a login or password, whoever wrote it, and when it is empty. */
export async function postComment(env: Env, taskId: string, author: CommentAuthor, body: string, now: Date): Promise<void> {
  await need(env, taskId);
  refuseCredentials([body]);
  await addComment(env.DB, taskId, author, body, now.toISOString());
}
