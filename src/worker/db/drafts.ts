import type { Draft, DraftInsert, Purpose } from "../types";

type Row = Omit<Draft, "edited" | "include_footer"> & { edited: number; include_footer: number };
/** Job-hunting drafts (`full_time`) were removed; any left in the table are treated as freelance until deleted. */
export const normalizePurpose = (_: string): Purpose => "freelance";
const fromRow = (r: Row): Draft => ({ ...r, purpose: normalizePurpose(r.purpose), edited: r.edited === 1, include_footer: r.include_footer === 1 });

/** Newest first; within one variant group (same created_at) the first-written variant leads. */
const NEWEST = `ORDER BY created_at DESC, variant_index ASC`;

/**
 * "Write it myself" starts from an empty-ish draft so the editor has something to open. Until the sender changes it (`edited`, or the text no longer
 * matches) it is not a draft anybody wrote: it must not count as one in any queue or counter, and no sequence may start from it.
 */
export const PLACEHOLDER_SUBJECT = "A quick note about your website";
export const PLACEHOLDER_BODY = "Hi,";
export const isPlaceholderDraft = (d: { subject: string; body: string; edited: boolean }): boolean =>
  !d.edited && d.subject === PLACEHOLDER_SUBJECT && d.body === PLACEHOLDER_BODY;
/** The same rule as SQL, for a drafts row (`alias` is its table alias with a dot, or ""): true for a draft somebody wrote. */
export const realDraftSql = (alias = "") => `NOT (${alias}edited = 0 AND ${alias}subject = '${PLACEHOLDER_SUBJECT}' AND ${alias}body = '${PLACEHOLDER_BODY}')`;

const INSERT_DRAFT = `INSERT INTO drafts (id, business_id, audit_id, to_contact_id, recipient_reason, subject, body, offer,
     steering_note, purpose, angle, include_footer, variant_group, variant_index, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const bindDraft = (db: D1Database, id: string, d: DraftInsert) => db.prepare(INSERT_DRAFT).bind(
  id, d.business_id, d.audit_id, d.to_contact_id, d.recipient_reason, d.subject, d.body, d.offer,
  d.steering_note, d.purpose ?? "freelance", d.angle ?? "", (d.include_footer ?? true) ? 1 : 0, d.variant_group ?? null,
  d.variant_index ?? 0, d.created_at ?? new Date().toISOString());

export async function insertDraft(db: D1Database, d: DraftInsert): Promise<Draft> {
  const id = crypto.randomUUID();
  await bindDraft(db, id, d).run();
  return fromRow((await db.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(id).first<Row>())!);
}

/** Several drafts in one atomic batch (with `also`, any statements that belong with them): a crash cannot leave a variant group half written. */
export async function insertDrafts(db: D1Database, ds: DraftInsert[], also: D1PreparedStatement[] = []): Promise<void> {
  if (ds.length) await db.batch([...ds.map((d) => bindDraft(db, crypto.randomUUID(), d)), ...also]);
}

/** True when some draft was written under this variant group. */
export async function hasVariantGroup(db: D1Database, group: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS x FROM drafts WHERE variant_group = ? LIMIT 1`).bind(group).first()) !== null;
}

export async function latestDraft(db: D1Database, businessId: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE business_id = ? ${NEWEST} LIMIT 1`).bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** The current draft of every lead that has one (the newest group's first variant, same rule as `latestDraft`); an untouched "Write it myself" placeholder is not one. */
export async function latestDraftsByBusiness(db: D1Database): Promise<Map<string, Draft>> {
  const { results } = await db.prepare(
    `SELECT * FROM (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY created_at DESC, variant_index ASC) AS rn FROM drafts d WHERE ${realDraftSql("d.")}) WHERE rn = 1`,
  ).all<Row & { rn: number }>();
  return new Map(results.map((r) => [r.business_id, fromRow(r)]));
}

/** Which of these leads have at least one draft somebody wrote (for the "Drafts ready" view). */
export async function draftedIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 80) { // stay under D1's bound-parameter limit
    const chunk = ids.slice(i, i + 80);
    const { results } = await db.prepare(`SELECT DISTINCT business_id FROM drafts WHERE ${realDraftSql()} AND business_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ business_id: string }>();
    for (const r of results) out.add(r.business_id);
  }
  return out;
}

export async function getDraft(db: D1Database, businessId: string, id: string): Promise<Draft | null> {
  const r = await db.prepare(`SELECT * FROM drafts WHERE id = ? AND business_id = ?`).bind(id, businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** Saves the editor. A save that leaves a still-empty placeholder as it was (the footer switch, say) does not make it a written draft. */
export async function updateDraftBody(db: D1Database, id: string, u: { subject: string; body: string; include_footer?: boolean }) {
  const edited = `edited = CASE WHEN NOT (${realDraftSql()}) AND ? = '${PLACEHOLDER_SUBJECT}' AND ? = '${PLACEHOLDER_BODY}' THEN 0 ELSE 1 END`;
  if (u.include_footer === undefined) {
    await db.prepare(`UPDATE drafts SET subject = ?, body = ?, ${edited} WHERE id = ?`).bind(u.subject, u.body, u.subject, u.body, id).run();
  } else {
    await db.prepare(`UPDATE drafts SET subject = ?, body = ?, include_footer = ?, ${edited} WHERE id = ?`)
      .bind(u.subject, u.body, u.include_footer ? 1 : 0, u.subject, u.body, id).run();
  }
}

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
