import type { Business, LeadStatus, Listing, ScanStage } from "../types";
import { isSocialOnlyUrl } from "../crawler/extract";
import { namesSimilar } from "../import/names";
import { activityStmt } from "./activity";

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A usable site domain: normalized, has a dot, and is not a shared social/listing host (those never identify one business). */
export function siteDomain(url: string | null | undefined): string | null {
  const d = domainOf(url?.trim() || null);
  return d && d.includes(".") && !isSocialOnlyUrl(`https://${d}/`) ? d : null;
}

/** The domain a stored business is matched on: its own column, else its website's host. Never a social host. */
export const businessDomain = (b: Pick<Business, "domain" | "website_url">): string | null => siteDomain(b.domain) ?? siteDomain(b.website_url);

/** A `businesses` row as stored: `tags` is a JSON string. Every read goes through `fromBusinessRow` so callers only ever see `string[]`. */
type BusinessRow = Omit<Business, "tags"> & { tags: string | null };

export function fromBusinessRow(r: BusinessRow): Business {
  let tags: string[] = [];
  try {
    const t = JSON.parse(r.tags ?? "[]");
    if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === "string");
  } catch { /* unreadable tags are treated as none */ }
  return { ...r, tags };
}
const rows = (r: BusinessRow[]) => r.map(fromBusinessRow);
const one = (r: BusinessRow | null) => (r ? fromBusinessRow(r) : null);

export const MAX_TAGS = 20, MAX_TAG_LENGTH = 32;
/** Lowercase, spaces collapsed, nothing outside a-z 0-9 space - _. Null when nothing is left or it is over 32 characters. */
export function normalizeTag(raw: string): string | null {
  const t = raw.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 _-]/g, "").replace(/ {2,}/g, " ").trim();
  return t && t.length <= MAX_TAG_LENGTH ? t : null;
}

export async function getBusiness(db: D1Database, id: string): Promise<Business | null> {
  return one(await db.prepare(`SELECT * FROM businesses WHERE id = ?`).bind(id).first<BusinessRow>());
}

export async function upsertBusiness(db: D1Database, l: Listing, searchId: string): Promise<Business> {
  // Social/platform hosts (facebook.com, yelp.com, ...) are shared by unrelated businesses: never store or match them.
  const rawDomain = domainOf(l.websiteUrl);
  const domain = rawDomain && !isSocialOnlyUrl(`https://${rawDomain}/`) ? rawDomain : null;
  let existing: Business | null = null;
  if (l.placeId) existing = one(await db.prepare(`SELECT * FROM businesses WHERE place_id = ?`).bind(l.placeId).first<BusinessRow>());
  // Domain fallback only when one side lacks a place_id; two distinct place_ids are two businesses (e.g. chain branches).
  if (!existing && domain) {
    existing = one(l.placeId
      ? await db.prepare(`SELECT * FROM businesses WHERE domain = ? AND place_id IS NULL`).bind(domain).first<BusinessRow>()
      : await db.prepare(`SELECT * FROM businesses WHERE domain = ?`).bind(domain).first<BusinessRow>());
  }

  let id: string;
  if (existing) {
    id = existing.id;
    await db.prepare(
      `UPDATE businesses SET name = ?, category = COALESCE(?, category), address = COALESCE(?, address),
       phone = COALESCE(?, phone), website_url = COALESCE(?, website_url), maps_url = COALESCE(?, maps_url),
       rating = COALESCE(?, rating), review_count = COALESCE(?, review_count),
       place_id = COALESCE(place_id, ?), domain = COALESCE(domain, ?) WHERE id = ?`,
    ).bind(l.name, l.category, l.address, l.phone, l.websiteUrl, l.mapsUrl, l.rating, l.reviewCount, l.placeId, domain, id).run();
  } else {
    id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO businesses (id, place_id, domain, name, category, address, phone, website_url, maps_url,
       rating, review_count, first_seen_search_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, l.placeId, domain, l.name, l.category, l.address, l.phone, l.websiteUrl, l.mapsUrl,
      l.rating, l.reviewCount, searchId, new Date().toISOString()).run();
  }
  await db.prepare(`INSERT OR IGNORE INTO search_results (search_id, business_id) VALUES (?, ?)`).bind(searchId, id).run();
  return (await getBusiness(db, id))!;
}

export async function listBusinessesForSearch(db: D1Database, searchId: string, o: { hideSkipped: boolean }) {
  const sql = `SELECT b.* FROM businesses b JOIN search_results sr ON sr.business_id = b.id
    WHERE sr.search_id = ? AND b.archived_at IS NULL ${o.hideSkipped ? "AND b.lead_status != 'skip'" : ""}`;
  return rows((await db.prepare(sql).bind(searchId).all<BusinessRow>()).results);
}

/** `tag` must already be normalized (see `normalizeTag`). */
export async function listAllBusinesses(db: D1Database, o: { status?: LeadStatus; limit?: number; offset?: number; archived?: boolean; tag?: string }) {
  const where = [o.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const args: (string | number)[] = [];
  if (o.status) { where.push("lead_status = ?"); args.push(o.status); }
  // json_each throws on malformed JSON, which would fail the whole list over one bad row; such a row just has no tags.
  if (o.tag) { where.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(businesses.tags) THEN businesses.tags ELSE '[]' END) WHERE value = ?)"); args.push(o.tag); }
  const stmt = db.prepare(`SELECT * FROM businesses WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...args, o.limit ?? -1, o.offset ?? 0);
  return rows((await stmt.all<BusinessRow>()).results);
}

/** Leads that have had only the cheap crawl-and-score pass, newest first. Archived ones are left out. */
export async function listQuickStageBusinesses(db: D1Database, limit = 500) {
  return rows((await db.prepare(`SELECT * FROM businesses WHERE scan_stage = 'quick' AND archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit).all<BusinessRow>()).results);
}

/** A lead the Today queue might list, with the two values it needs that live in other tables. */
export type TodayCandidate = Business & { latest_draft_at: string | null; latest_score: number | null };

/**
 * Non-archived leads that could produce a Today item as of `nowIso`, from one query: a due follow-up, a new/reviewed lead with a draft,
 * a contacted/replied lead with a deal value, or a quick-scanned lead whose latest audit scores at least `minQuickScore`.
 * The draft time and latest score are sub-selects so no per-lead query is needed; the caller applies the finer rules.
 */
export async function listTodayCandidates(db: D1Database, nowIso: string, minQuickScore: number): Promise<TodayCandidate[]> {
  const open = `lead_status NOT IN ('won','lost','skip')`;
  const latestScore = `(SELECT a.score FROM audits a WHERE a.business_id = businesses.id ORDER BY a.created_at DESC LIMIT 1)`;
  const sql = `SELECT *, (SELECT MAX(d.created_at) FROM drafts d WHERE d.business_id = businesses.id) AS latest_draft_at, ${latestScore} AS latest_score
    FROM businesses WHERE archived_at IS NULL AND (
      (follow_up_at IS NOT NULL AND follow_up_at <= ? AND ${open})
      OR (lead_status IN ('new','reviewed') AND EXISTS (SELECT 1 FROM drafts d WHERE d.business_id = businesses.id))
      OR (lead_status IN ('contacted','replied') AND deal_value IS NOT NULL)
      OR (scan_stage = 'quick' AND ${open} AND ${latestScore} >= ?)
    ) ORDER BY created_at, id`;
  const res = (await db.prepare(sql).bind(nowIso, minQuickScore).all<BusinessRow & { latest_draft_at: string | null; latest_score: number | null }>()).results;
  return res.map((r) => ({ ...fromBusinessRow(r), latest_draft_at: r.latest_draft_at ?? null, latest_score: r.latest_score ?? null }));
}

export async function setScanStage(db: D1Database, id: string, stage: ScanStage) {
  await db.prepare(`UPDATE businesses SET scan_stage = ? WHERE id = ?`).bind(stage, id).run();
}

const archiveStmt = (db: D1Database, id: string, archived: boolean, at = new Date().toISOString()) =>
  db.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(archived ? at : null, id);
// Moving to "contacted" stamps contacted_at; any other status leaves it alone.
const statusStmt = (db: D1Database, id: string, status: LeadStatus, at = new Date().toISOString()) =>
  db.prepare(`UPDATE businesses SET lead_status = ?, contacted_at = COALESCE(?, contacted_at) WHERE id = ?`)
    .bind(status, status === "contacted" ? at : null, id);

export async function setArchived(db: D1Database, id: string, archived: boolean) {
  await archiveStmt(db, id, archived).run();
  return (await getBusiness(db, id))!;
}

/** Permanently removes a lead and everything recorded about it. Raw crawl files in R2 are left to expire. */
export async function deleteBusiness(db: D1Database, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM cro_items WHERE cro_audit_id IN (SELECT id FROM cro_audits WHERE business_id = ?)`).bind(id),
    ...["search_results", "audits", "contacts", "drafts", "people", "activity", "cro_audits", "audit_reports"].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE business_id = ?`).bind(id)),
    db.prepare(`DELETE FROM businesses WHERE id = ?`).bind(id),
  ]);
}

export async function updateLead(db: D1Database, id: string, u: {
  leadStatus?: LeadStatus; notes?: string; followUpAt?: string | null; dealValue?: number | null; websiteUrl?: string | null;
}) {
  if (u.followUpAt !== undefined) await db.prepare(`UPDATE businesses SET follow_up_at = ? WHERE id = ?`).bind(u.followUpAt, id).run();
  if (u.dealValue !== undefined) await db.prepare(`UPDATE businesses SET deal_value = ? WHERE id = ?`).bind(u.dealValue, id).run();
  if (u.websiteUrl !== undefined) {
    const raw = domainOf(u.websiteUrl);
    const domain = raw && !isSocialOnlyUrl(`https://${raw}/`) ? raw : null;
    await db.prepare(`UPDATE businesses SET website_url = ?, domain = ? WHERE id = ?`).bind(u.websiteUrl, domain, id).run();
  }
  if (u.leadStatus) await statusStmt(db, id, u.leadStatus).run();
  if (u.notes !== undefined) await db.prepare(`UPDATE businesses SET notes = ? WHERE id = ?`).bind(u.notes, id).run();
  return (await getBusiness(db, id))!;
}

export type BulkOp =
  | { action: "status"; status: LeadStatus }
  | { action: "archive" | "restore" }
  | { action: "tag" | "untag"; tag: string };
/**
 * What a bulk action wrote to one lead: the value it replaced and the value it left, for ONLY the columns that action touches
 * (status: lead_status + contacted_at; archive/restore: archived_at; tag/untag: tags). Undo puts `before` back only while the
 * lead still holds `after`, so an edit made since (a status change, opening a "new" lead, a tag edit) is never overwritten.
 */
type BulkSnapshot =
  | { id: string; kind: "status"; before: { lead_status: LeadStatus; contacted_at: string | null }; after: { lead_status: LeadStatus; contacted_at: string | null } }
  | { id: string; kind: "archived"; before: { archived_at: string | null }; after: { archived_at: string | null } }
  | { id: string; kind: "tags"; before: { tags: string[] }; after: { tags: string[] } };

export const UNDO_WINDOW_MS = 10 * 60_000;
// D1 allows 100 bound variables per statement.
const IN_CHUNK = 90;
async function businessesByIds(db: D1Database, ids: string[]): Promise<Map<string, Business>> {
  const found = new Map<string, Business>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const r = await db.prepare(`SELECT * FROM businesses WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<BusinessRow>();
    for (const b of rows(r.results)) found.set(b.id, b);
  }
  return found;
}

/** The change `op` makes to one lead, with its activity detail and snapshot; null when the lead is already as asked (or cannot take the tag). */
function bulkChange(db: D1Database, b: Business, op: BulkOp, at: string): { stmt: D1PreparedStatement; detail: string; snap: BulkSnapshot } | null {
  const tagStmt = (tags: string[]) => db.prepare(`UPDATE businesses SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), b.id);
  switch (op.action) {
    case "status": {
      if (b.lead_status === op.status) return null;
      const contacted_at = op.status === "contacted" ? at : b.contacted_at;
      return { stmt: statusStmt(db, b.id, op.status, at), detail: `status → ${op.status} (bulk)`,
        snap: { id: b.id, kind: "status", before: { lead_status: b.lead_status, contacted_at: b.contacted_at }, after: { lead_status: op.status, contacted_at } } };
    }
    case "archive":
      return b.archived_at ? null : { stmt: archiveStmt(db, b.id, true, at), detail: "archive (bulk)",
        snap: { id: b.id, kind: "archived", before: { archived_at: null }, after: { archived_at: at } } };
    case "restore":
      return b.archived_at ? { stmt: archiveStmt(db, b.id, false), detail: "restore (bulk)",
        snap: { id: b.id, kind: "archived", before: { archived_at: b.archived_at }, after: { archived_at: null } } } : null;
    case "tag": {
      if (b.tags.includes(op.tag) || b.tags.length >= MAX_TAGS) return null;
      const tags = [...b.tags, op.tag];
      return { stmt: tagStmt(tags), detail: `tag "${op.tag}" (bulk)`, snap: { id: b.id, kind: "tags", before: { tags: b.tags }, after: { tags } } };
    }
    case "untag": {
      if (!b.tags.includes(op.tag)) return null;
      const tags = b.tags.filter((t) => t !== op.tag);
      return { stmt: tagStmt(tags), detail: `untag "${op.tag}" (bulk)`, snap: { id: b.id, kind: "tags", before: { tags: b.tags }, after: { tags } } };
    }
  }
}

/**
 * Applies one action to many leads in a single batch: the changes, one `bulk` activity row per changed lead, and an undo
 * snapshot. Unknown ids are ignored; leads already as asked (or at the tag cap) are counted in `skipped` and left alone.
 * `tag` must already be normalized.
 */
export async function applyBulk(db: D1Database, ids: string[], op: BulkOp): Promise<{ updated: number; skipped: number; undoToken: string | null }> {
  const now = new Date();
  await db.prepare(`DELETE FROM bulk_undo WHERE created_at < ?`).bind(new Date(now.getTime() - UNDO_WINDOW_MS).toISOString()).run();
  const found = await businessesByIds(db, [...new Set(ids)]);
  const stmts: D1PreparedStatement[] = [];
  const snapshot: BulkSnapshot[] = [];
  for (const b of found.values()) {
    const change = bulkChange(db, b, op, now.toISOString());
    if (!change) continue;
    snapshot.push(change.snap);
    stmts.push(change.stmt, activityStmt(db, b.id, "bulk", change.detail));
  }
  const skipped = found.size - snapshot.length;
  if (!snapshot.length) return { updated: 0, skipped, undoToken: null };
  const undoToken = crypto.randomUUID();
  stmts.push(db.prepare(`INSERT INTO bulk_undo (token, snapshot, created_at) VALUES (?,?,?)`).bind(undoToken, JSON.stringify(snapshot), now.toISOString()));
  await db.batch(stmts);
  return { updated: snapshot.length, skipped, undoToken };
}

/** True while the lead still holds exactly what the bulk action wrote to the columns it touched. */
function stillAsBulkLeftIt(b: Business, s: BulkSnapshot): boolean {
  switch (s.kind) {
    case "status": return b.lead_status === s.after.lead_status && b.contacted_at === s.after.contacted_at;
    case "archived": return b.archived_at === s.after.archived_at;
    case "tags": return JSON.stringify(b.tags) === JSON.stringify(s.after.tags);
  }
}

/** The guarded restore: the WHERE repeats the check so a write landing between the read and the batch still cannot be clobbered. */
function restoreStmt(db: D1Database, s: BulkSnapshot): D1PreparedStatement {
  switch (s.kind) {
    case "status":
      return db.prepare(`UPDATE businesses SET lead_status = ?, contacted_at = ? WHERE id = ? AND lead_status = ? AND contacted_at IS ?`)
        .bind(s.before.lead_status, s.before.contacted_at, s.id, s.after.lead_status, s.after.contacted_at);
    case "archived":
      return db.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ? AND archived_at IS ?`).bind(s.before.archived_at, s.id, s.after.archived_at);
    case "tags":
      return db.prepare(`UPDATE businesses SET tags = ? WHERE id = ? AND tags = ?`).bind(JSON.stringify(s.before.tags), s.id, JSON.stringify(s.after.tags));
  }
}

/**
 * Puts back what a bulk action wrote, column by column, and only on leads still as the action left them; a lead edited since is
 * counted in `skipped` and left alone (a lead deleted since is ignored). Null when the token is unknown, already used or older than 10 minutes.
 */
export async function undoBulk(db: D1Database, token: string): Promise<{ restored: number; skipped: number } | null> {
  // Deleting is the claim, so two undos racing for one token cannot both restore.
  const row = await db.prepare(`DELETE FROM bulk_undo WHERE token = ? RETURNING snapshot, created_at`).bind(token).first<{ snapshot: string; created_at: string }>();
  if (!row || Date.parse(row.created_at) < Date.now() - UNDO_WINDOW_MS) return null;
  const snapshot = JSON.parse(row.snapshot) as BulkSnapshot[];
  const current = await businessesByIds(db, snapshot.map((s) => s.id));
  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const s of snapshot) {
    const b = current.get(s.id);
    if (!b) continue;
    if (!stillAsBulkLeftIt(b, s)) { skipped++; continue; }
    stmts.push(restoreStmt(db, s), activityStmt(db, s.id, "bulk", "undo"));
  }
  if (stmts.length) await db.batch(stmts);
  return { restored: stmts.length / 2, skipped };
}

export async function setBusinessError(db: D1Database, id: string, msg: string | null) {
  await db.prepare(`UPDATE businesses SET last_error = ? WHERE id = ?`).bind(msg, id).run();
}

/** Every business, for matching many import rows against without a query per row. Archived leads are included: re-importing one is still a duplicate. */
export async function loadMatchPool(db: D1Database): Promise<Business[]> {
  return rows((await db.prepare(`SELECT * FROM businesses ORDER BY created_at, id`).all<BusinessRow>()).results);
}

/**
 * Existing businesses that share the row's domain or have a similar name (see `namesSimilar`). `pool` lets a caller that
 * checks many rows pass `loadMatchPool` once (and add what it creates) instead of reading the table per row.
 */
export async function findBusinessCandidates(
  db: D1Database, row: { name: string; url: string | null }, pool?: Business[],
): Promise<Business[]> {
  const domain = siteDomain(row.url);
  return (pool ?? (await loadMatchPool(db))).filter((b) => (domain && businessDomain(b) === domain) || namesSimilar(row.name, b.name));
}
