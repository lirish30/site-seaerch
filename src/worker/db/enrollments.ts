import type { Enrollment } from "../sequence/types";

export const getEnrollment = (db: D1Database, id: string): Promise<Enrollment | null> =>
  db.prepare(`SELECT * FROM enrollments WHERE id = ?`).bind(id).first<Enrollment>();

/** Every enrollment the lead has ever had, newest first. */
export async function enrollmentsFor(db: D1Database, businessId: string): Promise<Enrollment[]> {
  return (await db.prepare(`SELECT * FROM enrollments WHERE business_id = ? ORDER BY started_at DESC, id`).bind(businessId).all<Enrollment>()).results;
}
