import type { MilestoneKey } from "../sop/model";

export const PROJECT_KINDS = ["build", "quick_fix", "care_onboarding", "custom"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const PROJECT_STATUSES = ["active", "paused", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: string; businessId: string; dealId: string | null; documentId: string | null; onboardingId: string | null; kind: ProjectKind; name: string; status: ProjectStatus;
  pausedReason: string | null; test: boolean; templateKey: string | null; templateVersion: number | null; careDeferred: boolean; startedAt: string; completedAt: string | null;
  createdAt: string; updatedAt: string;
}

interface Row {
  id: string; business_id: string; deal_id: string | null; document_id: string | null; onboarding_id: string | null; kind: ProjectKind; name: string; status: ProjectStatus;
  paused_reason: string | null; test: number; template_key: string | null; template_version: number | null; care_deferred: number; started_at: string; completed_at: string | null;
  created_at: string; updated_at: string;
}

const toProject = (r: Row): Project => ({
  id: r.id, businessId: r.business_id, dealId: r.deal_id, documentId: r.document_id, onboardingId: r.onboarding_id, kind: r.kind, name: r.name, status: r.status,
  pausedReason: r.paused_reason, test: !!r.test, templateKey: r.template_key, templateVersion: r.template_version, careDeferred: !!r.care_deferred, startedAt: r.started_at,
  completedAt: r.completed_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

const nowIso = () => new Date().toISOString();

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const r = await db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<Row>();
  return r ? toProject(r) : null;
}

/**
 * Starts a project. One project exists per (document, template): a second call for the same pair returns the first with `created: false` and changes nothing.
 * A project with no document (one Logan starts by hand) is never limited, because a null never conflicts in the unique index.
 */
export async function createProject(db: D1Database, o: {
  businessId: string; dealId: string | null; documentId: string | null; onboardingId: string | null; kind: ProjectKind; name: string; test: boolean;
  templateKey: string | null; templateVersion: number | null; careDeferred: boolean; startedAt: string;
}): Promise<{ project: Project; created: boolean }> {
  const id = crypto.randomUUID();
  const now = nowIso();
  const res = await db.prepare(
    `INSERT INTO projects (id, business_id, deal_id, document_id, onboarding_id, kind, name, test, template_key, template_version, care_deferred, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (document_id, template_key) DO NOTHING`,
  ).bind(id, o.businessId, o.dealId, o.documentId, o.onboardingId, o.kind, o.name, o.test ? 1 : 0, o.templateKey, o.templateVersion, o.careDeferred ? 1 : 0, o.startedAt, now, now).run();
  if ((res.meta.changes ?? 0) === 1) return { project: (await getProject(db, id))!, created: true };
  // Only the (document, template) pair can have made the insert do nothing (any other violation raised above), so that project must be there.
  const existing = await db.prepare(`SELECT * FROM projects WHERE document_id = ? AND template_key = ?`).bind(o.documentId, o.templateKey).first<Row>();
  if (!existing) throw new Error(`project for document ${o.documentId} and template ${o.templateKey} was neither created nor found`);
  return { project: toProject(existing), created: false };
}

/**
 * Every project (newest first), with its business name and task counts: `doneTasks` counts done and skipped tasks, `openTasks` the rest (a locked change-order task is still open work).
 * An empty `status` list matches nothing.
 */
export async function listProjects(db: D1Database, o: { status?: ProjectStatus[]; businessId?: string } = {}): Promise<(Project & { businessName: string; openTasks: number; doneTasks: number })[]> {
  const where: string[] = [];
  const binds: string[] = [];
  if (o.status) {
    if (!o.status.length) return [];
    where.push(`p.status IN (${o.status.map(() => "?").join(", ")})`);
    binds.push(...o.status);
  }
  if (o.businessId) { where.push(`p.business_id = ?`); binds.push(o.businessId); }
  const rows = (await db.prepare(
    `SELECT p.*, b.name AS business_name,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done', 'skipped')) AS open_tasks,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('done', 'skipped')) AS done_tasks
     FROM projects p JOIN businesses b ON b.id = p.business_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.started_at DESC, p.created_at DESC, p.id`,
  ).bind(...binds).all<Row & { business_name: string; open_tasks: number; done_tasks: number }>()).results;
  return rows.map((r) => ({ ...toProject(r), businessName: r.business_name, openTasks: r.open_tasks, doneTasks: r.done_tasks }));
}

/** Whether the lead has a project: a lead that does is archived, never deleted. */
export async function hasProject(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM projects WHERE business_id = ? LIMIT 1`).bind(businessId).first());
}

/**
 * Sets the status. The guard is in the statement: a done or cancelled project never reopens (the row is returned as it is). `done` stamps `completedAt`;
 * the reason is kept only while paused. Throws when there is no such project.
 */
export async function setProjectStatus(db: D1Database, id: string, status: ProjectStatus, o: { reason?: string | null; now?: string } = {}): Promise<Project> {
  const now = o.now ?? nowIso();
  await db.prepare(
    `UPDATE projects SET status = ?, paused_reason = ?, completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END, updated_at = ?
     WHERE id = ? AND status NOT IN ('done', 'cancelled')`,
  ).bind(status, status === "paused" ? (o.reason ?? null) : null, status, now, now, id).run();
  const p = await getProject(db, id);
  if (!p) throw new Error(`project ${id} not found`);
  return p;
}

/** Records that the project reached a milestone. True only the first time. */
export async function reachMilestone(db: D1Database, projectId: string, m: MilestoneKey, now: string): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO project_milestones (project_id, milestone, reached_at) VALUES (?, ?, ?)`).bind(projectId, m, now).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function listMilestones(db: D1Database, projectId: string): Promise<{ milestone: MilestoneKey; reachedAt: string }[]> {
  const rows = (await db.prepare(`SELECT milestone, reached_at FROM project_milestones WHERE project_id = ? ORDER BY reached_at, milestone`).bind(projectId).all<{ milestone: MilestoneKey; reached_at: string }>()).results;
  return rows.map((r) => ({ milestone: r.milestone, reachedAt: r.reached_at }));
}

/** Attaches a recurring template to the project. True only the first time. */
export async function addCadence(db: D1Database, projectId: string, templateKey: string): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO project_cadences (id, project_id, template_key, created_at) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), projectId, templateKey, nowIso()).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function listCadences(db: D1Database, o: { activeProjectsOnly?: boolean } = {}): Promise<{ id: string; projectId: string; templateKey: string }[]> {
  const rows = (await db.prepare(
    `SELECT c.id, c.project_id, c.template_key FROM project_cadences c ${o.activeProjectsOnly ? `JOIN projects p ON p.id = c.project_id AND p.status = 'active'` : ""} ORDER BY c.created_at, c.rowid`,
  ).all<{ id: string; project_id: string; template_key: string }>()).results;
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, templateKey: r.template_key }));
}
