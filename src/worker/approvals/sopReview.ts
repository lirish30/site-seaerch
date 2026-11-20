import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import type { Approval } from "../db/approvals";
import { getProject } from "../db/projects";
import { getTask, type ChecklistItem, type Task } from "../db/tasks";
import { completeTask } from "../projects/service";

const Payload = z.object({ taskId: z.string().min(1) });
export type SopReviewPayload = z.infer<typeof Payload>;

/** What Claude sent back for a step, as the card shows it. Nothing here is acted on: it is Logan's to read. */
export interface ReviewDetails {
  summary: string;
  links?: string[];
  checklist?: ChecklistItem[];
  needsLogan?: string;
  /** Titles of steps this one still waits on (Claude finished it before they were done). */
  waitingOn?: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What Logan reads before approving: the step, what Claude says it did, anything that needs him, the links and the checklist. */
function previewOf(task: Task, projectName: string, d: ReviewDetails): string {
  return [
    `Step: ${task.title} (${projectName})`,
    ...(task.doneWhen ? [`Done when: ${task.doneWhen}`] : []),
    "",
    "Claude says:",
    d.summary,
    ...(d.needsLogan ? ["", `Needs you: ${d.needsLogan}`] : []),
    ...(d.waitingOn?.length ? ["", `Still waiting on: ${d.waitingOn.join(", ")}`] : []),
    ...(d.links?.length ? ["", "Links:", ...d.links.map((l) => `- ${l}`)] : []),
    ...(d.checklist?.length ? ["", "Checklist:", ...d.checklist.map((c) => `[${c.done ? "x" : " "}] ${c.text}`)] : []),
    "",
    "Approving marks this step done. Nothing has been sent to the client.",
  ].join("\n");
}

const waitingFor = (db: D1Database, taskId: string) =>
  db.prepare(`SELECT * FROM approvals WHERE kind = 'sop.review' AND status = 'pending' AND json_extract(payload, '$.taskId') = ? ORDER BY created_at, id LIMIT 1`).bind(taskId)
    .first<Omit<Approval, "payload"> & { payload: string }>().then((r) => (r ? ({ ...r, payload: JSON.parse(r.payload) } as Approval) : null));

/**
 * Puts Claude's work on a step up for Logan's approval. One waiting approval per task, decided in one statement (two results at once, or a retry after a crash,
 * end with one card): a second call returns the one that is waiting. Nothing happens until Logan approves.
 */
export async function createReviewApproval(env: Env, task: Task, d: ReviewDetails): Promise<Approval> {
  const db = env.DB;
  const project = await getProject(db, task.projectId);
  const a: Approval = {
    id: crypto.randomUUID(), kind: "sop.review", title: clip(`Approve Claude's step: ${task.title} (${project?.name ?? "project"})`, 200), preview: previewOf(task, project?.name ?? "project", d),
    payload: { taskId: task.id } satisfies SopReviewPayload, record_type: "task", record_id: task.id, drafted_by: "mcp", status: "pending", error: null, decision_note: null,
    created_at: new Date().toISOString(), decided_at: null,
  };
  const res = await db.prepare(
    `INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
     SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE kind = 'sop.review' AND status = 'pending' AND json_extract(payload, '$.taskId') = ?)`,
  ).bind(a.id, a.kind, a.title, a.preview, JSON.stringify(a.payload), a.record_type, a.record_id, a.drafted_by, a.status, a.created_at, task.id).run();
  if ((res.meta.changes ?? 0) > 0) return a;
  const existing = await waitingFor(db, task.id);
  if (!existing) return createReviewApproval(env, task, d); // it was decided between the two statements: put the new one up
  return existing;
}

/** Removes the waiting review for a task (its step moved on before the card was needed). Only a waiting one is touched. */
export async function discardReviewApproval(db: D1Database, taskId: string): Promise<void> {
  await db.prepare(`DELETE FROM approvals WHERE kind = 'sop.review' AND status = 'pending' AND json_extract(payload, '$.taskId') = ?`).bind(taskId).run();
}

registerHandler({
  kind: "sop.review",
  label: "Approve Claude's step",
  parse: (p) => Payload.parse(p),
  /**
   * Finishes the step as Logan. Safe to run again: a step that is already done is passed to `completeTask`, which repairs anything half-recorded and fires nothing when all is recorded.
   * A step that is no longer in review (reopened, skipped, locked, or put back to to-do) is refused, so a stale card cannot finish work that has moved on.
   */
  async execute(env: Env, p: SopReviewPayload) {
    const t = await getTask(env.DB, p.taskId);
    if (!t) throw new Error("This step no longer exists.");
    if (t.status !== "done" && t.status !== "in_review" && t.status !== "in_progress") throw new Error("This step is no longer waiting for your review.");
    await completeTask(env, t.id, { by: "logan", now: new Date() });
  },
});
