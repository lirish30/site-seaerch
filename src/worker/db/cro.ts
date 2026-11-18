import type { BizModelKey, BusinessModel, CroAudit, CroItem, CroStatus, PageReview, Positioning, RankedItem, ScenarioInputs, TrackingEvent } from "../cro/types";
import { CRO_LIMITS } from "../cro/config";
import { chunks } from "./chunks";

const JSON_COLS = ["pages", "evidence", "business_model", "model_overrides", "page_reviews", "pending_pages", "strengths", "positioning",
  "tracking_plan", "scenario_inputs", "models_used"] as const;
const FALLBACK: Record<(typeof JSON_COLS)[number], unknown> = {
  pages: [], evidence: [], business_model: null, model_overrides: {}, page_reviews: [], pending_pages: [], strengths: [], positioning: null,
  tracking_plan: [], scenario_inputs: null, models_used: {},
};
const parse = (s: unknown, fallback: unknown) => { try { return typeof s === "string" ? JSON.parse(s) : fallback; } catch { return fallback; } };

function auditFromRow(r: Record<string, unknown>): CroAudit {
  const out: Record<string, unknown> = { ...r, partial: r.partial === 1 };
  for (const c of JSON_COLS) out[c] = parse(r[c], FALLBACK[c]);
  return out as unknown as CroAudit;
}

function itemFromRow(r: Record<string, unknown>): CroItem {
  return { ...r, evidence_ids: parse(r.evidence_ids, []), included: r.included === 1, edited: r.edited === 1 } as unknown as CroItem;
}

export async function createCroAudit(db: D1Database, businessId: string): Promise<CroAudit> {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await db.prepare(`INSERT INTO cro_audits (id, business_id, created_at, started_at) VALUES (?,?,?,?)`).bind(id, businessId, now, now).run();
  return (await getCroAudit(db, id))!;
}

export async function getCroAudit(db: D1Database, id: string): Promise<CroAudit | null> {
  const r = await db.prepare(`SELECT * FROM cro_audits WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return r ? auditFromRow(r) : null;
}

export async function latestCroAudit(db: D1Database, businessId: string, o: { status?: CroStatus } = {}): Promise<CroAudit | null> {
  const r = await db.prepare(`SELECT * FROM cro_audits WHERE business_id = ? ${o.status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 1`)
    .bind(...(o.status ? [businessId, o.status] : [businessId])).first<Record<string, unknown>>();
  return r ? auditFromRow(r) : null;
}

export async function listCroAudits(db: D1Database, businessId: string) {
  return (await db.prepare(
    `SELECT a.id, a.status, a.created_at, a.completed_at, (SELECT COUNT(*) FROM cro_items i WHERE i.cro_audit_id = a.id) AS item_count
     FROM cro_audits a WHERE a.business_id = ? ORDER BY a.created_at DESC`,
  ).bind(businessId).all<{ id: string; status: CroStatus; created_at: string; completed_at: string | null; item_count: number }>()).results;
}

export type CroAuditPatch = Partial<Omit<CroAudit, "id" | "business_id" | "created_at">>;
export async function updateCroAudit(db: D1Database, id: string, patch: CroAuditPatch) {
  const keys = Object.keys(patch) as (keyof CroAuditPatch)[];
  if (!keys.length) return;
  const vals = keys.map((k) => {
    const v = patch[k];
    if ((JSON_COLS as readonly string[]).includes(k)) return v === null ? null : JSON.stringify(v);
    if (k === "partial") return v ? 1 : 0;
    return v ?? null;
  });
  await db.prepare(`UPDATE cro_audits SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...vals, id).run();
}

// An audit that completed once (completed_at is kept across rebuilds) keeps its last good roadmap when a later run fails:
// it goes back to done and the failure is noted in `error`. A run that never finished is failed, so Retry shows.
const FAIL_SET = `status = CASE WHEN completed_at IS NOT NULL THEN 'done' ELSE 'failed' END,
  step = CASE WHEN completed_at IS NOT NULL THEN 'done' ELSE step END, error = ?`;

export async function failCroAudit(db: D1Database, id: string, message: string) {
  await db.prepare(`UPDATE cro_audits SET ${FAIL_SET} WHERE id = ?`).bind(message, id).run();
}

// The queued stages. Each of these is one guarded UPDATE, so two sessions finishing at the same moment (or a rebuild landing in between) cannot
// lose each other's work: whichever statement runs second finds its condition false and changes nothing.

/** A task queued at `notBefore` still belongs to the audit's current run; without a time (an expiry sweep, which has no task row) any run does. */
const FRESH = `(? IS NULL OR stages_at IS NULL OR stages_at <= ?)`;

/**
 * The business model was answered: saves it, starts the page reviews fresh (an earlier run's reviews are dropped) and lists the pages still to review.
 * True when this call did it; false when the audit was no longer waiting on the model (answered already, or rebuilt since the task was queued).
 */
export async function beginPageReviews(db: D1Database, id: string, p: { model: BusinessModel; reviewedAs: BizModelKey; indexes: number[]; notBefore: string }): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE cro_audits SET business_model = ?, reviewed_as = ?, page_reviews = '[]', pending_pages = ?, step = 'pages'
     WHERE id = ? AND status = 'waiting' AND step = 'model' AND ${FRESH}`,
  ).bind(JSON.stringify(p.model), p.reviewedAs, JSON.stringify(p.indexes), id, p.notBefore, p.notBefore).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * One page is settled: its review (null when the page is given up on) is appended and the page leaves `pending_pages`, in a single statement.
 * Returns the pages still pending, or null when nothing changed (the page was not pending: already settled, or the audit was rebuilt or moved on).
 */
export async function settlePage(db: D1Database, id: string, index: number, review: PageReview | null, notBefore?: string): Promise<number[] | null> {
  const r = await db.prepare(
    `UPDATE cro_audits SET page_reviews = CASE WHEN ? IS NULL THEN page_reviews ELSE json_insert(page_reviews, '$[#]', json(?)) END,
       pending_pages = (SELECT json_group_array(value) FROM json_each(pending_pages) WHERE value <> ?)
     WHERE id = ? AND status = 'waiting' AND step = 'pages' AND ${FRESH} AND EXISTS (SELECT 1 FROM json_each(pending_pages) WHERE value = ?)
     RETURNING pending_pages`,
  ).bind(review && JSON.stringify(review), review && JSON.stringify(review), index, id, notBefore ?? null, notBefore ?? null, index).first<{ pending_pages: string }>();
  return r ? (JSON.parse(r.pending_pages) as number[]) : null;
}

/** Every page is in (or given up on): the audit moves on to the roadmap and notes what was skipped. True when this call moved it. */
export async function finishPageReviews(db: D1Database, id: string, p: { partial: boolean; warning: string | null }): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE cro_audits SET step = 'synthesize', partial = ?, warning = ? WHERE id = ? AND status = 'waiting' AND step = 'pages' AND json_array_length(pending_pages) = 0`,
  ).bind(p.partial ? 1 : 0, p.warning, id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * The roadmap is written: the audit is done. Runs only while the audit is still waiting on the roadmap of the run the task belongs to, so a result
 * for an audit that was rebuilt or moved on in the meantime changes nothing. True when this call finished the audit.
 */
export async function finishRoadmap(db: D1Database, id: string, p: {
  strengths: string[]; positioning: Positioning; tracking_plan: TrackingEvent[]; scenario_inputs: ScenarioInputs; warning: string | null; completedAt: string; notBefore: string;
}): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE cro_audits SET strengths = ?, positioning = ?, tracking_plan = ?, scenario_inputs = ?, warning = ?, status = 'done', step = 'done', error = NULL, completed_at = ?
     WHERE id = ? AND status = 'waiting' AND step = 'synthesize' AND ${FRESH}`,
  ).bind(JSON.stringify(p.strengths), JSON.stringify(p.positioning), JSON.stringify(p.tracking_plan), JSON.stringify(p.scenario_inputs), p.warning, p.completedAt,
    id, p.notBefore, p.notBefore).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The lead's in-flight audit, if any. Runs stuck past the limit (a dead workflow) are failed so they stop blocking new runs.
 *  Measured from started_at, which rebuilds and retries reset. */
export async function runningCroAudit(db: D1Database, businessId: string, now: Date): Promise<CroAudit | null> {
  const cutoff = new Date(now.getTime() - CRO_LIMITS.staleRunningMs).toISOString();
  await db.prepare(`UPDATE cro_audits SET ${FAIL_SET} WHERE business_id = ? AND status = 'running' AND started_at < ?`)
    .bind("Timed out", businessId, cutoff).run();
  const r = await db.prepare(`SELECT * FROM cro_audits WHERE business_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Record<string, unknown>>();
  return r ? auditFromRow(r) : null;
}

/** Replaces the roadmap; items the user edited are kept and a regenerated item with the same title is skipped. */
export async function replaceCroItems(db: D1Database, auditId: string, items: RankedItem[]) {
  const kept = await listCroItems(db, auditId).then((xs) => xs.filter((x) => x.edited));
  const keptTitles = new Set(kept.map((x) => x.title.trim().toLowerCase()));
  const now = new Date().toISOString();
  const fresh = items.filter((i) => !keptTitles.has(i.title.trim().toLowerCase()));
  await db.batch([
    db.prepare(`DELETE FROM cro_items WHERE cro_audit_id = ? AND edited = 0`).bind(auditId),
    ...fresh.map((i) => db.prepare(
      `INSERT INTO cro_items (id, cro_audit_id, rank, horizon, title, observation, change, why, area, mode, impact, effort,
       evidence_ids, catalog_id, we_can_do_it, pxl_score, included, edited, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)`,
    ).bind(crypto.randomUUID(), auditId, i.rank, i.horizon, i.title, i.observation, i.change, i.why, i.area, i.mode, i.impact, i.effort,
      JSON.stringify(i.evidence_ids), i.catalog_id, i.we_can_do_it, i.pxl_score, now)),
  ]);
}

export async function listCroItems(db: D1Database, auditId: string): Promise<CroItem[]> {
  return (await db.prepare(`SELECT * FROM cro_items WHERE cro_audit_id = ? ORDER BY rank, created_at`).bind(auditId)
    .all<Record<string, unknown>>()).results.map(itemFromRow);
}

export type CroItemPatch = Partial<Pick<CroItem, "title" | "observation" | "change" | "why" | "we_can_do_it" | "included" | "rank" | "horizon">>;
export async function updateCroItem(db: D1Database, id: string, patch: CroItemPatch): Promise<CroItem | null> {
  const keys = Object.keys(patch) as (keyof CroItemPatch)[];
  if (keys.length) {
    const vals = keys.map((k) => (k === "included" ? (patch[k] ? 1 : 0) : patch[k]));
    await db.prepare(`UPDATE cro_items SET ${keys.map((k) => `${k} = ?`).join(", ")}, edited = 1 WHERE id = ?`).bind(...vals, id).run();
  }
  const r = await db.prepare(`SELECT * FROM cro_items WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return r ? itemFromRow(r) : null;
}

/** Items by id, restricted to audits that belong to this business. */
export async function croItemsForBusiness(db: D1Database, businessId: string, ids: string[]): Promise<CroItem[]> {
  const out: CroItem[] = [];
  for (const part of chunks([...new Set(ids)])) {
    const rows = (await db.prepare(
      `SELECT i.* FROM cro_items i JOIN cro_audits a ON a.id = i.cro_audit_id WHERE a.business_id = ? AND i.id IN (${part.map(() => "?").join(",")})`,
    ).bind(businessId, ...part).all<Record<string, unknown>>()).results;
    out.push(...rows.map(itemFromRow));
  }
  return out;
}
