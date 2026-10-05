import type { Activity, ActivityKind } from "../types";

/** The insert as an unexecuted statement, for callers that write many rows in one `db.batch`. */
export const activityStmt = (db: D1Database, businessId: string, kind: ActivityKind, detail: string | null = null) =>
  db.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`)
    .bind(crypto.randomUUID(), businessId, kind, detail, new Date().toISOString());

export async function logActivity(db: D1Database, businessId: string, kind: ActivityKind, detail: string | null = null) {
  await activityStmt(db, businessId, kind, detail).run();
}

export async function listActivity(db: D1Database, businessId: string, limit = 50): Promise<Activity[]> {
  return (await db.prepare(`SELECT * FROM activity WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(businessId, limit).all<Activity>()).results;
}
