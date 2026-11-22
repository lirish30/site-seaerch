import { CARE_4 } from "../care/tasks";
import { SEO_1 } from "../seo/tasks";
import type { Env } from "../env";
import { holdFreeSql, isOnHold } from "../db/holds";
import { getProject, liveProjectSql, projectIsLive } from "../db/projects";
import { getTask, listTasks, setTaskStatus } from "../db/tasks";
import { cancelTasksFor, enqueueTask } from "../queue/db";
import { failedJobCount, giveBack, MAX_AUTO_RETRIES, SOP_STEP_KIND } from "../queue/sopStep";
import { readyClaudeTasks } from "../sop/ready";
import { onTasksChanged } from "./hooks";
import { postComment, TaskStateError } from "./service";
import { projectWaiting } from "./waiting";

export { MAX_AUTO_RETRIES };

/** The most Claude step jobs queued or being worked at once, across every project. */
export const MAX_IN_FLIGHT = 5;

/** What Ask Claude says for a client whose overdue invoice has put the hold on: their tasks can still be worked by hand. */
export const HELD_REFUSAL = "This client has an unpaid invoice, so Claude cannot start on this step until it is paid. You can still work it by hand.";

/** Statuses a step can be handed to Claude from: any that is still open. */
const OPEN = ["todo", "in_progress", "in_review", "waiting_client"] as const;

/**
 * Hands one step to Claude: the step becomes `in_progress` and a `sop.step` job is queued for it (one open job per step). A note, when given, is saved as a `logan` comment first
 * (refused, and nothing is queued, when it reads like a login or password). Works on any open step of an active project, a test project's included and a step Logan owns; this is what
 * "Ask Claude" and a send-back call. `queued` is false when Claude already holds the step (a second request asks for nothing new). A job left open by a step that was reopened is picked
 * up again rather than doubled.
 */
export async function requestClaudeStep(env: Env, taskId: string, o: { note?: string } = {}): Promise<{ queued: boolean }> {
  const db = env.DB;
  const task = await getTask(db, taskId);
  if (!task) throw new TaskStateError("There is no such task.");
  if (task.status === "done") throw new TaskStateError("This step is already done. Reopen it to ask Claude to work on it.");
  if (task.status === "skipped") throw new TaskStateError("This step was skipped. Reopen it to ask Claude to work on it.");
  if (task.status === "locked") throw new TaskStateError("This task is locked, so Claude cannot start on it yet.");
  const project = await getProject(db, task.projectId);
  if (!project || !projectIsLive(project)) throw new TaskStateError(`This project is ${project?.status ?? "gone"}, so Claude cannot start on it.`);
  if (await isOnHold(db, project.businessId)) throw new TaskStateError(HELD_REFUSAL);

  if (o.note !== undefined && o.note.trim()) await postComment(env, taskId, "logan", o.note, new Date()); // throws TaskInputError: nothing is queued

  const { id, created } = await enqueueTask(db, SOP_STEP_KIND, { taskId }, { dedupeKey: taskId, targetType: "task", targetId: taskId });
  if (task.status === "in_progress" && task.claudeTaskId === id) return { queued: false };
  if (await setTaskStatus(db, taskId, "in_progress", { from: [...OPEN], now: new Date().toISOString(), claudeTaskId: id })) return { queued: true };
  // Lost a race (the step was finished or locked meanwhile): a job made just now has nothing to do.
  if (created) await cancelTasksFor(db, "task", taskId);
  return { queued: false };
}

/**
 * Step jobs that count against the limit: queued or claimed, and still holding their step. A job whose step has moved on (its result was just applied, or Logan took the step over)
 * no longer takes a place, so a finished step makes room for the next one in the same moment.
 */
async function inFlight(db: D1Database): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM claude_tasks c WHERE c.kind = ? AND c.status IN ('pending', 'claimed')
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.target_id AND t.claude_task_id = c.id AND t.status = 'in_progress')`,
  ).bind(SOP_STEP_KIND).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Active, real projects that have a Claude step still to do, the oldest project first. */
async function candidates(db: D1Database): Promise<string[]> {
  return (await db.prepare(
    `SELECT p.id FROM projects p WHERE ${liveProjectSql("p")} AND ${holdFreeSql("p")} AND p.test = 0
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status = 'todo' AND t.owner IN ('claude', 'claude_drafts'))
     ORDER BY p.started_at, p.created_at, p.id`,
  ).all<{ id: string }>()).results.map((r) => r.id);
}

/**
 * Steps left in progress under a job that has ended (stale, failed, expired or done) and that nobody has touched since it ended: they go back to to-do, so nothing stays stranded when a path
 * forgot to give the step back. A step Logan changed after the job ended (he started it from review, or took it off waiting) is his and is left alone.
 */
async function reclaimStranded(env: Env): Promise<void> {
  const rows = (await env.DB.prepare(
    `SELECT t.id AS task_id, c.id AS job_id FROM tasks t JOIN claude_tasks c ON c.id = t.claude_task_id
     WHERE t.status = 'in_progress' AND c.kind = ? AND c.status IN ('stale', 'failed', 'expired', 'done') AND c.done_at IS NOT NULL AND t.updated_at <= c.done_at`,
  ).bind(SOP_STEP_KIND).all<{ task_id: string; job_id: string }>()).results;
  for (const r of rows) {
    try { await giveBack(env, r.task_id, { jobId: r.job_id }); }
    catch (e) { console.error("projects: could not reclaim a stranded step", e instanceof Error ? e.message : "unknown error"); }
  }
}

/**
 * Queues every Claude step that is ready, for real projects that are active, not waiting on the client and whose client has no billing hold (an invoice unpaid past the pause day), up to `MAX_IN_FLIGHT` jobs in flight in all (and `limit` new ones when given).
 * A test project is never dispatched (a rehearsal must not spend subscription time unasked): "Ask Claude" works on it. Running it twice queues once, because a step handed to Claude
 * is no longer to do. The monthly Care report task (CARE-4) and the monthly Local SEO task (SEO-1) are never dispatched here. A step whose jobs have failed or expired `MAX_AUTO_RETRIES` times is skipped. Returns how many steps it handed over.
 */
export async function dispatchReady(env: Env, now: Date, o: { limit?: number } = {}): Promise<{ queued: number }> {
  const db = env.DB;
  await reclaimStranded(env);
  const room = MAX_IN_FLIGHT - (await inFlight(db));
  const cap = Math.min(room, o.limit ?? room);
  let queued = 0;
  if (cap <= 0) return { queued };
  for (const id of await candidates(db)) {
    if (queued >= cap) break;
    const project = await getProject(db, id);
    if (!project || !projectIsLive(project) || project.test || (await isOnHold(db, project.businessId))) continue;
    if (await projectWaiting(db, project, now)) continue;
    for (const t of readyClaudeTasks(await listTasks(db, id), { projectActive: true, waiting: false })) {
      if (queued >= cap) break;
      // The monthly Care report is built by the report sweep (its own `care.report` job writes the summary): handing its task to Claude as a step would make a second, unrelated job for the same work. Ask Claude still works on it. The monthly Local SEO task (SEO-1) is the same: its pull, drafts and report have their own jobs.
      if (t.cadenceKey === CARE_4 || t.cadenceKey === SEO_1) continue;
      // Claude has failed this step enough times: it waits for Logan (Ask Claude still works).
      if ((await failedJobCount(db, t.id)) >= MAX_AUTO_RETRIES) continue;
      try { if ((await requestClaudeStep(env, t.id)).queued) queued++; }
      catch (e) { console.error("projects: could not hand a step to Claude", e instanceof Error ? e.message : "unknown error"); }
    }
  }
  return { queued };
}

/** The tasks-changed hook: whatever changed, look again at what is ready (the project id is not needed, since the limit is across every project). */
export async function dispatchOnTasksChanged(env: Env, _projectId: string): Promise<void> {
  await dispatchReady(env, new Date());
}
onTasksChanged(dispatchOnTasksChanged);
