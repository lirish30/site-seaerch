// The retention ladder (Plan 15): the steps owed to a client after a build, each with a due day and a status.
// Times (`now`, `createdAt`, `doneAt`) are UTC ISO strings with milliseconds. `dueOn` and `today` are local dates (YYYY-MM-DD) the caller worked out in the booking zone.

export type LadderStep = "review_request" | "testimonial" | "thank_you" | "check_in" | "case_study" | "december_letter";
export type LadderStatus = "waiting" | "drafted" | "due" | "done" | "skipped";

export interface LadderRow {
  id: string; businessId: string; projectId: string | null; step: LadderStep; dueOn: string; status: LadderStatus; approvalId: string | null; link: string | null; note: string; createdAt: string; doneAt: string | null;
}

interface Row {
  id: string; business_id: string; project_id: string | null; step: LadderStep; due_on: string; status: LadderStatus; approval_id: string | null; link: string | null; note: string; created_at: string; done_at: string | null;
}

const toRow = (r: Row): LadderRow => ({
  id: r.id, businessId: r.business_id, projectId: r.project_id, step: r.step, dueOn: r.due_on, status: r.status, approvalId: r.approval_id, link: r.link, note: r.note, createdAt: r.created_at, doneAt: r.done_at,
});

/** Adds the steps, each `waiting`. A step the business already has on that day is left alone. Returns how many were new. */
export async function insertLadderRows(
  db: D1Database, rows: Omit<LadderRow, "id" | "createdAt" | "doneAt" | "approvalId" | "status" | "note" | "link">[], now: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const results = await db.batch(rows.map((r) =>
    db.prepare(`INSERT INTO ladder_steps (id, business_id, project_id, step, due_on, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (business_id, step, due_on) DO NOTHING`)
      .bind(crypto.randomUUID(), r.businessId, r.projectId, r.step, r.dueOn, now)));
  return results.reduce((n, res) => n + (res.meta.changes ?? 0), 0);
}

/** Every step of one business, soonest due first. */
export async function listLadder(db: D1Database, businessId: string): Promise<LadderRow[]> {
  const rows = (await db.prepare(`SELECT * FROM ladder_steps WHERE business_id = ? ORDER BY due_on, rowid`).bind(businessId).all<Row>()).results;
  return rows.map(toRow);
}

/** The `waiting` steps due on `today` or before, oldest first, at most `limit`. */
export async function dueLadderRows(db: D1Database, today: string, limit: number): Promise<LadderRow[]> {
  const rows = (await db.prepare(`SELECT * FROM ladder_steps WHERE status = 'waiting' AND due_on <= ? ORDER BY due_on, rowid LIMIT ?`).bind(today, limit).all<Row>()).results;
  return rows.map(toRow);
}

/**
 * Moves one step to `to`. `approvalId` and `note` are stored when given (a field left out is not touched). `done` and `skipped` stamp `done_at` with `now` (or clear nothing when `now` is left out);
 * any other status clears it. Returns false when there is no such step. It does not check the state the step was in.
 */
export async function setLadderStatus(db: D1Database, id: string, to: LadderStatus, o: { approvalId?: string; note?: string; now?: string }): Promise<boolean> {
  const finished = to === "done" || to === "skipped";
  const res = await db.prepare(
    `UPDATE ladder_steps SET status = ?, approval_id = COALESCE(?, approval_id), note = COALESCE(?, note), done_at = ? WHERE id = ?`,
  ).bind(to, o.approvalId ?? null, o.note ?? null, finished ? (o.now ?? null) : null, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Sets or clears (null) the link the step carries, such as a review page. Returns false when there is no such step. */
export async function setLadderLink(db: D1Database, id: string, link: string | null): Promise<boolean> {
  const res = await db.prepare(`UPDATE ladder_steps SET link = ? WHERE id = ?`).bind(link, id).run();
  return (res.meta.changes ?? 0) === 1;
}
