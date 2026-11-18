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
