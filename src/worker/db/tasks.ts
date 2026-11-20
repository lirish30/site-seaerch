import { z } from "zod";
import { cleanText, looksLikeCredential } from "../onboarding/templates";
import { OWNER_TAGS, TASK_STATUSES, type MilestoneKey, type OwnerTag, type TaskStatus } from "../sop/model";

export interface ChecklistItem { text: string; done: boolean }

export interface Task {
  id: string; projectId: string; businessId: string; isStep: boolean; stepKey: string | null; phaseKey: string; phaseTitle: string; position: number; title: string; description: string;
  owner: OwnerTag; status: TaskStatus; doneWhen: string; estMinutes: number; dueOn: string | null; billable: boolean; skippable: boolean; requires: string[]; milestone: MilestoneKey | null;
  clientSummary: string | null; docTemplate: string | null; emailTemplate: string | null; checklist: ChecklistItem[]; changeOrderId: string | null; cadenceKey: string | null;
  periodKey: string | null; claudeTaskId: string | null; reviewApprovalId: string | null; startedAt: string | null; doneAt: string | null; createdAt: string; updatedAt: string;
}
/** A task about to be inserted: the id, timestamps and the links a Claude job fills in later are made here. */
export type NewTask = Omit<Task, "id" | "createdAt" | "updatedAt" | "startedAt" | "doneAt" | "claudeTaskId" | "reviewApprovalId">;

/** The text Logan or Claude sent was refused. The message is a plain sentence; nothing was saved. */
export class TaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskInputError";
  }
}

interface Row {
  id: string; project_id: string; business_id: string; is_step: number; step_key: string | null; phase_key: string; phase_title: string; position: number; title: string; description: string;
  owner: OwnerTag; status: TaskStatus; done_when: string; est_minutes: number; due_on: string | null; billable: number; skippable: number; requires: string; milestone: MilestoneKey | null;
  client_summary: string | null; doc_template: string | null; email_template: string | null; checklist: string; change_order_id: string | null; cadence_key: string | null;
  period_key: string | null; claude_task_id: string | null; review_approval_id: string | null; started_at: string | null; done_at: string | null; created_at: string; updated_at: string;
}

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const stringList = (s: string): string[] => { const v = parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; };
const checklistOf = (s: string): ChecklistItem[] => {
  const v = parse(s);
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (x && typeof x === "object" && typeof (x as ChecklistItem).text === "string" ? [{ text: (x as ChecklistItem).text, done: (x as ChecklistItem).done === true }] : []));
};

const toTask = (r: Row): Task => ({
  id: r.id, projectId: r.project_id, businessId: r.business_id, isStep: !!r.is_step, stepKey: r.step_key, phaseKey: r.phase_key, phaseTitle: r.phase_title, position: r.position,
  title: r.title, description: r.description, owner: r.owner, status: r.status, doneWhen: r.done_when, estMinutes: r.est_minutes, dueOn: r.due_on, billable: !!r.billable,
  skippable: !!r.skippable, requires: stringList(r.requires), milestone: r.milestone, clientSummary: r.client_summary, docTemplate: r.doc_template, emailTemplate: r.email_template,
  checklist: checklistOf(r.checklist), changeOrderId: r.change_order_id, cadenceKey: r.cadence_key, periodKey: r.period_key, claudeTaskId: r.claude_task_id,
  reviewApprovalId: r.review_approval_id, startedAt: r.started_at, doneAt: r.done_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

const nowIso = () => new Date().toISOString();

export async function getTask(db: D1Database, id: string): Promise<Task | null> {
  const r = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<Row>();
  return r ? toTask(r) : null;
}

/** A project's tasks in order. */
export async function listTasks(db: D1Database, projectId: string): Promise<Task[]> {
  return (await db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY position, rowid`).bind(projectId).all<Row>()).results.map(toTask);
}

/**
 * Inserts the tasks in one batch: all of them or none (a step key already used in the project fails the whole batch). The rows come back as inserted.
 */
export async function insertTasks(db: D1Database, rows: NewTask[]): Promise<Task[]> {
  if (!rows.length) return [];
  const now = nowIso();
  const out: Task[] = rows.map((n) => ({ ...n, id: crypto.randomUUID(), claudeTaskId: null, reviewApprovalId: null, startedAt: null, doneAt: null, createdAt: now, updatedAt: now }));
  await db.batch(out.map((t) => db.prepare(
    `INSERT INTO tasks (id, project_id, business_id, is_step, step_key, phase_key, phase_title, position, title, description, owner, status, done_when, est_minutes, due_on, billable, skippable,
       requires, milestone, client_summary, doc_template, email_template, checklist, change_order_id, cadence_key, period_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    t.id, t.projectId, t.businessId, t.isStep ? 1 : 0, t.stepKey, t.phaseKey, t.phaseTitle, t.position, t.title, t.description, t.owner, t.status, t.doneWhen, t.estMinutes, t.dueOn,
    t.billable ? 1 : 0, t.skippable ? 1 : 0, JSON.stringify(t.requires), t.milestone, t.clientSummary, t.docTemplate, t.emailTemplate, JSON.stringify(t.checklist), t.changeOrderId,
    t.cadenceKey, t.periodKey, now, now,
  )));
  return out;
}

/**
 * The open tasks Logan works, across active projects: his own tasks that are to do or under way, and Claude's drafts that are waiting for his review.
 * Whether a task is ready (its requirements met, its phase reached) is derived elsewhere; this is the list before that.
 * Soonest due date first (undated last), then the older project, then step order.
 */
export async function listOpenTasksForLogan(db: D1Database): Promise<(Task & { projectName: string; businessName: string })[]> {
  const rows = (await db.prepare(
    `SELECT t.*, p.name AS project_name, b.name AS business_name FROM tasks t JOIN projects p ON p.id = t.project_id JOIN businesses b ON b.id = t.business_id
     WHERE p.status = 'active' AND ((t.owner = 'logan' AND t.status IN ('todo', 'in_progress')) OR (t.owner = 'claude_drafts' AND t.status = 'in_review'))
     ORDER BY t.due_on IS NULL, t.due_on, p.started_at, p.id, t.position, t.rowid`,
  ).all<Row & { project_name: string; business_name: string }>()).results;
  return rows.map((r) => ({ ...toTask(r), projectName: r.project_name, businessName: r.business_name }));
}

/** What the owner can change on a task. A field left out is not touched; null clears `dueOn` and `clientSummary`. */
export interface TaskPatch {
  title?: string; description?: string; owner?: OwnerTag; doneWhen?: string; estMinutes?: number; dueOn?: string | null; billable?: boolean; skippable?: boolean;
  requires?: string[]; checklist?: ChecklistItem[]; clientSummary?: string | null;
}

/** A real calendar date: "2026-13-45" is not a date at all and "2026-02-30" would roll into March. Never throws. */
const isCalendarDate = (s: string) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
};

/** Text is cleaned (control and bidirectional characters removed, ends trimmed) before its length is checked. */
const text = (label: string, max: number, o: { required?: boolean } = {}) =>
  z.string().transform((s) => cleanText(s, s.length)).pipe(z.string().max(max, `${label} is at most ${max} characters.`).refine((s) => !o.required || s.length > 0, `A task needs a title.`));

const PatchSchema = z.object({
  title: text("A title", 120, { required: true }),
  description: text("A description", 2000),
  owner: z.enum(OWNER_TAGS, "A task owner must be Claude, Logan, or Claude drafts."),
  doneWhen: text("A done-when", 300),
  estMinutes: z.number("An estimate must be a number of minutes.").int("An estimate must be whole minutes.").min(0, "An estimate cannot be negative.").max(600, "An estimate is at most 600 minutes."),
  dueOn: z.string().refine(isCalendarDate, "A due date must be a real date like 2026-12-24.").nullable(),
  billable: z.boolean(),
  skippable: z.boolean(),
  requires: z.array(z.string().max(20)).max(60, "A task can wait on at most 60 other steps."),
  checklist: z.array(z.object({ text: text("A checklist item", 200), done: z.boolean() })).max(40, "A checklist has at most 40 items."),
  clientSummary: text("A client summary", 80).transform((s) => s || null).nullable(),
}).partial().strict();

/** The patch with its text cleaned and every value checked. Throws TaskInputError (a plain sentence) for text over the caps, a blank title and values that are not allowed. */
export function parseTaskPatch(p: TaskPatch): TaskPatch {
  const parsed = PatchSchema.safeParse(p);
  if (!parsed.success) throw new TaskInputError(parsed.error.issues[0].message);
  return parsed.data;
}

/** Applies the patch and returns the task. Refuses (TaskInputError, nothing saved) text over the caps, a blank title and values that are not allowed. Throws when there is no such task. */
export async function patchTask(db: D1Database, id: string, p: TaskPatch, now: string): Promise<Task> {
  const v = parseTaskPatch(p);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => { sets.push(`${col} = ?`); vals.push(val); };
  if (v.title !== undefined) set("title", v.title);
  if (v.description !== undefined) set("description", v.description);
  if (v.owner !== undefined) set("owner", v.owner);
  if (v.doneWhen !== undefined) set("done_when", v.doneWhen);
  if (v.estMinutes !== undefined) set("est_minutes", v.estMinutes);
  if (v.dueOn !== undefined) set("due_on", v.dueOn);
  if (v.billable !== undefined) set("billable", v.billable ? 1 : 0);
  if (v.skippable !== undefined) set("skippable", v.skippable ? 1 : 0);
  if (v.requires !== undefined) set("requires", JSON.stringify(v.requires));
  if (v.checklist !== undefined) set("checklist", JSON.stringify(v.checklist));
  if (v.clientSummary !== undefined) set("client_summary", v.clientSummary);
  if (sets.length) {
    const res = await db.prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...vals, now, id).run();
    if ((res.meta.changes ?? 0) !== 1) throw new Error(`task ${id} not found`);
  }
  const t = await getTask(db, id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

/**
 * Moves the task to `toPosition` (0 is first, a number past either end is clamped) and renumbers the project's tasks 0, 1, 2... in one batch.
 * Throws when there is no such task.
 */
export async function moveTask(db: D1Database, id: string, toPosition: number): Promise<void> {
  const t = await getTask(db, id);
  if (!t) throw new Error(`task ${id} not found`);
  const rows = (await db.prepare(`SELECT id, position FROM tasks WHERE project_id = ? ORDER BY position, rowid`).bind(t.projectId).all<{ id: string; position: number }>()).results;
  const order = rows.filter((r) => r.id !== id);
  order.splice(Math.max(0, Math.min(Math.trunc(toPosition), order.length)), 0, { id, position: -1 });
  const changed = order.flatMap((r, i) => (r.position === i ? [] : [db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`).bind(i, r.id)]));
  if (changed.length) await db.batch(changed);
}

/**
 * Changes the status. `from`, when given, is checked in the statement itself, so the change happens only if the task is still in one of those statuses;
 * the result is true only when a row changed. `done` stamps `doneAt` (kept if already done) and any other status clears it; the first `in_progress` stamps `startedAt` and it is kept after.
 * `claudeTaskId` and `reviewApprovalId` are set when given (null clears) and left alone when left out.
 */
export async function setTaskStatus(db: D1Database, id: string, to: TaskStatus, o: {
  from?: TaskStatus[]; now: string; claudeTaskId?: string | null; reviewApprovalId?: string | null;
}): Promise<boolean> {
  if (!(TASK_STATUSES as readonly string[]).includes(to)) throw new Error(`unknown task status ${to}`);
  if (o.from && !o.from.length) return false;
  const sets = [
    `status = ?`,
    `done_at = CASE WHEN ? = 'done' THEN (CASE WHEN status = 'done' THEN done_at ELSE ? END) ELSE NULL END`,
    `started_at = CASE WHEN ? = 'in_progress' THEN COALESCE(started_at, ?) ELSE started_at END`,
    `updated_at = ?`,
  ];
  const binds: (string | null)[] = [to, to, o.now, to, o.now, o.now];
  if (o.claudeTaskId !== undefined) { sets.push(`claude_task_id = ?`); binds.push(o.claudeTaskId); }
  if (o.reviewApprovalId !== undefined) { sets.push(`review_approval_id = ?`); binds.push(o.reviewApprovalId); }
  binds.push(id);
  let where = `id = ?`;
  if (o.from) { where += ` AND status IN (${o.from.map(() => "?").join(", ")})`; binds.push(...o.from); }
  const res = await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where}`).bind(...binds).run();
  return (res.meta.changes ?? 0) === 1;
}

/** The task is still to do, was never started, has no time on it, and no other task in its project requires its step. Written once and used by both deletes below (it needs the id bound twice). */
const DELETABLE = `
  EXISTS (SELECT 1 FROM tasks d WHERE d.id = ? AND d.status = 'todo' AND d.started_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.task_id = d.id)
    AND NOT (d.step_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM tasks o, json_each(CASE WHEN json_valid(o.requires) THEN o.requires ELSE '[]' END) r
      WHERE o.project_id = d.project_id AND o.id <> d.id AND r.value = d.step_key)))`;

/** Deletes a task (and its comments) only when it is to do, never started, has no time entries and no other task requires its step. True when it was deleted. */
export async function deleteTask(db: D1Database, id: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare(`DELETE FROM task_comments WHERE task_id = ? AND ${DELETABLE}`).bind(id, id),
    db.prepare(`DELETE FROM tasks WHERE id = ? AND ${DELETABLE}`).bind(id, id),
  ]);
  return (res[1].meta.changes ?? 0) === 1;
}

/** What a refused login or password is told. The text itself is never echoed. */
export const CREDENTIAL_REFUSED = "This looks like a login or password. Never put those in a task; note where they are stored instead.";

export type CommentAuthor = "logan" | "claude" | "system";
export interface TaskComment { id: string; author: CommentAuthor; body: string; createdAt: string }

/**
 * Adds a note. The body is cleaned (control and bidirectional characters removed) and capped at 4000 characters. An empty note is refused, and so is a note from Logan or Claude
 * that reads like a login or password (a task never holds a credential); a line the app writes itself ("system") is not scanned.
 */
export async function addComment(db: D1Database, taskId: string, author: CommentAuthor, body: string, now: string): Promise<void> {
  const clean = cleanText(body, 4000);
  if (!clean) throw new TaskInputError("A comment cannot be empty.");
  if (author !== "system" && looksLikeCredential(clean)) throw new TaskInputError(CREDENTIAL_REFUSED);
  await db.prepare(`INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), taskId, author, clean, now).run();
}

export async function listComments(db: D1Database, taskId: string): Promise<TaskComment[]> {
  const rows = (await db.prepare(`SELECT id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid`).bind(taskId).all<{ id: string; author: CommentAuthor; body: string; created_at: string }>()).results;
  return rows.map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.created_at }));
}
