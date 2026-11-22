import { getHandler } from "../approvals/registry";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type Drafter = "job" | "mcp" | "logan";

export interface Approval {
  id: string; kind: string; title: string; preview: string; payload: unknown;
  record_type: string | null; record_id: string | null; drafted_by: Drafter;
  status: ApprovalStatus; error: string | null; decision_note: string | null;
  created_at: string; decided_at: string | null;
}

export class UnknownKindError extends Error {
  constructor(public kind: string) { super(`unknown approval kind: ${kind}`); this.name = "UnknownKindError"; }
}

type Row = Omit<Approval, "payload"> & { payload: string };
export const toApproval = (r: Row): Approval => ({ ...r, payload: JSON.parse(r.payload) });

const newRow = (a: Parameters<typeof createApproval>[1]): Row => ({
  id: crypto.randomUUID(), kind: a.kind, title: a.title, preview: a.preview, payload: JSON.stringify(a.payload ?? null),
  record_type: a.record_type ?? null, record_id: a.record_id ?? null, drafted_by: a.drafted_by,
  status: "pending", error: null, decision_note: null, created_at: new Date().toISOString(), decided_at: null,
});

export async function createApproval(db: D1Database, a: {
  kind: string; title: string; preview: string; payload: unknown;
  record_type?: string; record_id?: string; drafted_by: Drafter;
}): Promise<Approval> {
  if (!getHandler(a.kind)) throw new UnknownKindError(a.kind);
  const row = newRow(a);
  await db.prepare(`INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.kind, row.title, row.preview, row.payload, row.record_type, row.record_id, row.drafted_by, row.status, row.created_at).run();
  return toApproval(row);
}

/**
 * Creates the approval for one step of a record (an enrollment) unless that record already has one in flight: a pending approval,
 * or one a person has just claimed for this same step (status 'approved' while its send runs). The check and the insert are ONE
 * statement, so two scans running at once (or overlapping cron deliveries) can never create two. Null when one is in flight.
 */
export async function createApprovalUnlessOpen(db: D1Database, a: {
  kind: string; title: string; preview: string; payload: unknown; record_type: string; record_id: string; drafted_by: Drafter;
}, stepIndex: number): Promise<Approval | null> {
  if (!getHandler(a.kind)) throw new UnknownKindError(a.kind);
  const row = newRow(a);
  const res = await db.prepare(`INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM approvals WHERE record_type = ? AND record_id = ?
        AND (status = 'pending' OR (status = 'approved' AND json_extract(payload, '$.stepIndex') = ?)))`)
    .bind(row.id, row.kind, row.title, row.preview, row.payload, row.record_type, row.record_id, row.drafted_by, row.status, row.created_at,
      a.record_type, a.record_id, stepIndex).run();
  return (res.meta.changes ?? 0) > 0 ? toApproval(row) : null;
}

/**
 * Creates the approval a Claude task produces, at most ONE per task, in ONE statement: it is keyed to the task (`record_type 'claude_task'`,
 * `record_id` the task id), and an approval already there in ANY status (pending, or already approved or rejected) means nothing is created.
 * So a retry (a crash between this and finishing the task, a client resending after a timeout) and two completions at once all end with one
 * approval. Null when the task already has one. The record fields in `a` are replaced by the task's.
 */
export async function createApprovalForTask(db: D1Database, taskId: string, a: {
  kind: string; title: string; preview: string; payload: unknown; drafted_by: Drafter;
}): Promise<Approval | null> {
  if (!getHandler(a.kind)) throw new UnknownKindError(a.kind);
  const row = newRow({ ...a, record_type: "claude_task", record_id: taskId });
  const res = await db.prepare(`INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE record_type = 'claude_task' AND record_id = ?)`)
    .bind(row.id, row.kind, row.title, row.preview, row.payload, row.record_type, row.record_id, row.drafted_by, row.status, row.created_at, taskId).run();
  return (res.meta.changes ?? 0) > 0 ? toApproval(row) : null;
}

/**
 * Creates the approval for a payload key (`$.<key>` is `value`) unless one of this kind is already there in ANY status (pending, or already approved or rejected), in ONE statement,
 * so a retry and two callers at once all end with one. Null when one exists.
 */
export async function createApprovalOnce(db: D1Database, a: {
  kind: string; title: string; preview: string; payload: unknown; record_type: string; record_id: string; drafted_by: Drafter;
}, key: string, value: string): Promise<Approval | null> {
  if (!getHandler(a.kind)) throw new UnknownKindError(a.kind);
  const row = newRow(a);
  const res = await db.prepare(`INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ? AND json_extract(payload, ?) = ?)`)
    .bind(row.id, row.kind, row.title, row.preview, row.payload, row.record_type, row.record_id, row.drafted_by, row.status, row.created_at, a.kind, `$.${key}`, value).run();
  return (res.meta.changes ?? 0) > 0 ? toApproval(row) : null;
}

/** Rewrites the title and preview of an approval that is still pending (the card shows the record as it is now). False when it is decided or unknown: a decided card is history and stays as it was. */
export async function updatePendingCard(db: D1Database, id: string, card: { title: string; preview: string }): Promise<boolean> {
  const res = await db.prepare(`UPDATE approvals SET title = ?, preview = ? WHERE id = ? AND status = 'pending'`).bind(card.title, card.preview, id).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function listApprovals(db: D1Database, o: { status?: ApprovalStatus; limit?: number }): Promise<Approval[]> {
  const rows = (await db.prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(o.status ?? "pending", o.limit ?? 100).all<Row>()).results;
  return rows.map(toApproval);
}

/** Pending counts per kind, for the inbox badges. */
export async function pendingCounts(db: D1Database): Promise<Record<string, number>> {
  const rows = (await db.prepare(`SELECT kind, COUNT(*) AS n FROM approvals WHERE status = 'pending' GROUP BY kind`).all<{ kind: string; n: number }>()).results;
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}
