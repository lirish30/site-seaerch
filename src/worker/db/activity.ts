import type { Activity, ActivityKind } from "../types";

/** The insert as an unexecuted statement, for callers that write many rows in one `db.batch`. */
export const activityStmt = (db: D1Database, businessId: string, kind: ActivityKind, detail: string | null = null) =>
  db.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`)
    .bind(crypto.randomUUID(), businessId, kind, detail, new Date().toISOString());

/**
 * An insert for a batch that follows a statement guarded to change one row: the line is written only if that previous statement changed a row (SQLite's `changes()`),
 * so a state change and its log line land together or not at all, and a statement that changed nothing (a replay) logs nothing.
 */
export const activityIfChangedStmt = (db: D1Database, businessId: string, kind: ActivityKind, detail: string) =>
  db.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(crypto.randomUUID(), businessId, kind, detail, new Date().toISOString());

export async function logActivity(db: D1Database, businessId: string, kind: ActivityKind, detail: string | null = null) {
  await activityStmt(db, businessId, kind, detail).run();
}

/**
 * Logs a line unless the same one (same lead, kind and detail) is already there, in one statement so two callers at once leave one. `since` (an ISO time)
 * limits "already there" to lines newer than it, which keeps a repeating failure from filling the timeline. True when a line was written.
 */
export async function logActivityOnce(db: D1Database, businessId: string, kind: ActivityKind, detail: string, since = ""): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO activity (id, business_id, kind, detail, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM activity WHERE business_id = ?2 AND kind = ?3 AND detail = ?4 AND created_at > ?6)`,
  ).bind(crypto.randomUUID(), businessId, kind, detail, new Date().toISOString(), since).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function hasActivity(db: D1Database, businessId: string, kind: ActivityKind, detail: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM activity WHERE business_id = ? AND kind = ? AND detail = ? LIMIT 1`).bind(businessId, kind, detail).first());
}

export async function listActivity(db: D1Database, businessId: string, limit = 50): Promise<Activity[]> {
  return (await db.prepare(`SELECT * FROM activity WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(businessId, limit).all<Activity>()).results;
}
