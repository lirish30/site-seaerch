import type { Activity, ActivityKind } from "../types";

export async function logActivity(db: D1Database, businessId: string, kind: ActivityKind, detail: string | null = null) {
  await db.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`)
    .bind(crypto.randomUUID(), businessId, kind, detail, new Date().toISOString()).run();
}

export async function listActivity(db: D1Database, businessId: string, limit = 50): Promise<Activity[]> {
  return (await db.prepare(`SELECT * FROM activity WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(businessId, limit).all<Activity>()).results;
}
