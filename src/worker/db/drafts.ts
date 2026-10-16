import type { Draft, DraftInsert } from "../types";

type Row = Omit<Draft, "edited" | "include_footer"> & { edited: number; include_footer: number };
const fromRow = (r: Row): Draft => ({ ...r, edited: r.edited === 1, include_footer: r.include_footer === 1 });

/** Newest first; within one variant group (same created_at) the first-written variant leads. */
const NEWEST = `ORDER BY created_at DESC, variant_index ASC`;

export async function insertDraft(db: D1Database, d: DraftInsert): Promise<Draft> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO drafts (id, business_id, audit_id, to_contact_id, recipient_reason, subject, body, offer,
     steering_note, purpose, angle, include_footer, variant_group, variant_index, posting_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, d.business_id, d.audit_id, d.to_contact_id, d.recipient_reason, d.subject, d.body, d.offer,
    d.steering_note, d.purpose ?? "freelance", d.angle ?? "", (d.include_footer ?? true) ? 1 : 0, d.variant_group ?? null,
    d.variant_index ?? 0, d.posting_id ?? null, d.created_at ?? new Date().toISOString()).run();
  return fromRow((await db.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(id).first<Row>())!);
}

export async function latestDraft(db: D1Database, businessId: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE business_id = ? ${NEWEST} LIMIT 1`).bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The current draft of every lead that has one (the newest group's first variant, same rule as `latestDraft`). */
export async function latestDraftsByBusiness(db: D1Database): Promise<Map<string, Draft>> {
  const { results } = await db.prepare(
    `SELECT * FROM (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY created_at DESC, variant_index ASC) AS rn FROM drafts d) WHERE rn = 1`,
  ).all<Row & { rn: number }>();
  return new Map(results.map((r) => [r.business_id, fromRow(r)]));
}

/** Which of these leads have at least one draft (for the "Drafts ready" view). */
export async function draftedIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 80) { // stay under D1's bound-parameter limit
    const chunk = ids.slice(i, i + 80);
    const { results } = await db.prepare(`SELECT DISTINCT business_id FROM drafts WHERE business_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ business_id: string }>();
    for (const r of results) out.add(r.business_id);
  }
  return out;
}

export async function getDraft(db: D1Database, businessId: string, id: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE id = ? AND business_id = ?`).bind(id, businessId).first<Row>();
  return r ? fromRow(r) : null;
}

export async function updateDraftBody(db: D1Database, id: string, u: { subject: string; body: string; include_footer?: boolean }) {
  if (u.include_footer === undefined) {
    await db.prepare(`UPDATE drafts SET subject = ?, body = ?, edited = 1 WHERE id = ?`).bind(u.subject, u.body, id).run();
  } else {
    await db.prepare(`UPDATE drafts SET subject = ?, body = ?, include_footer = ?, edited = 1 WHERE id = ?`)
      .bind(u.subject, u.body, u.include_footer ? 1 : 0, id).run();
  }
}

/** The text no longer names the role, so the draft stops claiming it (the owner edited the sentence out). */
export const clearDraftPosting = (db: D1Database, id: string) => db.prepare(`UPDATE drafts SET posting_id = NULL WHERE id = ?`).bind(id).run();

/** Makes this draft the lead's current one (the newest), as picking a variant or an earlier version does. */
export async function selectDraft(db: D1Database, businessId: string, id: string, now = new Date()): Promise<Draft | null> {
  if (!(await getDraft(db, businessId, id))) return null;
  await db.prepare(`UPDATE drafts SET created_at = ? WHERE id = ?`).bind(now.toISOString(), id).run();
  return getDraft(db, businessId, id);
}

/** The drafts written together with this one, in the order they were written; just the draft when it has no group. */
export async function variantsOf(db: D1Database, d: Draft): Promise<Draft[]> {
  if (!d.variant_group) return [d];
  return (await db.prepare(`SELECT * FROM drafts WHERE variant_group = ? AND business_id = ? ORDER BY variant_index ASC`)
    .bind(d.variant_group, d.business_id).all<Row>()).results.map(fromRow);
}

export async function listDrafts(db: D1Database, businessId: string, limit = 20): Promise<Draft[]> {
  return (await db.prepare(`SELECT * FROM drafts WHERE business_id = ? ${NEWEST} LIMIT ?`)
    .bind(businessId, limit).all<Row>()).results.map(fromRow);
}
