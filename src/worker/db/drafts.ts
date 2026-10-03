import type { Draft, DraftInsert } from "../types";

type Row = Omit<Draft, "edited"> & { edited: number };
const fromRow = (r: Row): Draft => ({ ...r, edited: r.edited === 1 });

export async function insertDraft(db: D1Database, d: DraftInsert): Promise<Draft> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO drafts (id, business_id, audit_id, to_contact_id, recipient_reason, subject, body, offer,
     steering_note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, d.business_id, d.audit_id, d.to_contact_id, d.recipient_reason, d.subject, d.body, d.offer,
    d.steering_note, new Date().toISOString()).run();
  return fromRow((await db.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(id).first<Row>())!);
}

export async function latestDraft(db: D1Database, businessId: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function updateDraftBody(db: D1Database, id: string, u: { subject: string; body: string }) {
  await db.prepare(`UPDATE drafts SET subject = ?, body = ?, edited = 1 WHERE id = ?`).bind(u.subject, u.body, id).run();
}
