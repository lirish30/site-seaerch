import type { CareerSource, JobPosting, RoleKind } from "../types";
import { chunks } from "./chunks";
import { pickRole, postingState, SEEN_WITHIN_HOURS, type PostingState } from "../jobs/select";

export { SEEN_WITHIN_HOURS };

type PostingRow = Omit<JobPosting, "baseline"> & { baseline: number };
const toPosting = (r: PostingRow): JobPosting => ({ ...r, baseline: r.baseline === 1 });

export type SourceWrite = Pick<CareerSource, "business_id" | "status" | "next_check_at"> & { checked_at: string }
  & Partial<Pick<CareerSource, "ats" | "token" | "careers_url" | "last_ok_at" | "empty_streak" | "last_error">>;

export const getCareerSource = (db: D1Database, businessId: string) =>
  db.prepare(`SELECT * FROM career_sources WHERE business_id = ?`).bind(businessId).first<CareerSource>();

/** Upsert. Callers pass the whole picture: a field left out is written as null (0 for the streak). */
export async function saveCareerSource(db: D1Database, s: SourceWrite) {
  await db.prepare(
    `INSERT INTO career_sources (business_id, status, ats, token, careers_url, checked_at, last_ok_at, next_check_at, empty_streak, last_error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(business_id) DO UPDATE SET status = excluded.status, ats = excluded.ats, token = excluded.token, careers_url = excluded.careers_url,
       checked_at = excluded.checked_at, last_ok_at = excluded.last_ok_at, next_check_at = excluded.next_check_at,
       empty_streak = excluded.empty_streak, last_error = excluded.last_error`,
  ).bind(s.business_id, s.status, s.ats ?? null, s.token ?? null, s.careers_url ?? null, s.checked_at, s.last_ok_at ?? null,
    s.next_check_at, s.empty_streak ?? 0, s.last_error ?? null, s.checked_at).run();
}

/** Active boards that are due, for leads that still exist and are not archived. */
export async function listDueSources(db: D1Database, nowIso: string, limit: number): Promise<CareerSource[]> {
  return (await db.prepare(
    `SELECT s.* FROM career_sources s JOIN businesses b ON b.id = s.business_id
     WHERE s.status = 'active' AND s.next_check_at <= ? AND b.archived_at IS NULL ORDER BY s.next_check_at, s.business_id LIMIT ?`,
  ).bind(nowIso, limit).all<CareerSource>()).results;
}

/**
 * Scanned, non-archived leads with a website whose latest scan found a careers link (without one discovery would only park "none" and waste a slot;
 * "Check now" still works) and that have no board record yet, or whose "none"/"error" record is due for another look.
 * Never-checked leads come first, newest first, so a long backlog cannot starve fresh imports; then due rechecks, oldest first.
 */
export async function listUndiscovered(db: D1Database, nowIso: string, limit: number): Promise<{ id: string }[]> {
  return (await db.prepare(
    `SELECT b.id FROM businesses b LEFT JOIN career_sources s ON s.business_id = b.id
     WHERE b.archived_at IS NULL AND b.website_url IS NOT NULL
       AND COALESCE((SELECT CASE WHEN json_valid(a.site_links) THEN json_extract(a.site_links, '$.careers') END
                     FROM audits a WHERE a.business_id = b.id ORDER BY a.created_at DESC LIMIT 1), '') <> ''
       AND (s.business_id IS NULL OR (s.status IN ('none','error') AND s.next_check_at <= ?))
     ORDER BY s.business_id IS NOT NULL, CASE WHEN s.business_id IS NULL THEN b.created_at END DESC, s.next_check_at, b.id LIMIT ?`,
  ).bind(nowIso, limit).all<{ id: string }>()).results;
}

export interface PostingWrite {
  external_id: string; title: string; url: string; location: string | null; department: string | null;
  role_kind: RoleKind | null; posted_at: string | null;
}

/**
 * Writes one sync of a board. New roles are inserted (`baseline` marks the first look at a board), known ones are refreshed and reopened,
 * and every open role not seen in this sync is closed. Callers must not call this with an empty list: whether an empty answer may close
 * roles is their decision (see closeAll).
 */
export async function applySync(db: D1Database, businessId: string, rows: PostingWrite[], nowIso: string, baseline: boolean): Promise<{ added: JobPosting[]; closed: number }> {
  const known = new Set((await db.prepare(`SELECT external_id FROM job_postings WHERE business_id = ?`).bind(businessId).all<{ external_id: string }>()).results.map((r) => r.external_id));
  const added: JobPosting[] = [], stmts: D1PreparedStatement[] = [], seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.external_id)) continue;
    seen.add(r.external_id);
    if (known.has(r.external_id)) {
      stmts.push(db.prepare(
        `UPDATE job_postings SET title = ?, url = ?, location = ?, department = ?, role_kind = ?, posted_at = COALESCE(?, posted_at), last_seen_at = MAX(last_seen_at, ?), closed_at = NULL
         WHERE business_id = ? AND external_id = ?`,
      ).bind(r.title, r.url, r.location, r.department, r.role_kind, r.posted_at, nowIso, businessId, r.external_id));
    } else {
      const p: JobPosting = { id: crypto.randomUUID(), business_id: businessId, ...r, first_seen_at: nowIso, last_seen_at: nowIso, closed_at: null, baseline };
      added.push(p);
      stmts.push(db.prepare(
        `INSERT INTO job_postings (id, business_id, external_id, title, url, location, department, role_kind, posted_at, first_seen_at, last_seen_at, closed_at, baseline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)
         ON CONFLICT(business_id, external_id) DO UPDATE SET title = excluded.title, url = excluded.url, location = excluded.location, department = excluded.department,
           role_kind = excluded.role_kind, posted_at = COALESCE(excluded.posted_at, posted_at), last_seen_at = MAX(last_seen_at, excluded.last_seen_at), closed_at = NULL`,
      ).bind(p.id, businessId, r.external_id, r.title, r.url, r.location, r.department, r.role_kind, r.posted_at, nowIso, nowIso, baseline ? 1 : 0));
    }
  }
  for (const part of chunks(stmts, 50)) await db.batch(part);
  // Everything seen above now has last_seen_at >= nowIso; "<" (not "<>") so a sync that finished later is never undone by an overlapping older one.
  const closed = (await db.prepare(`UPDATE job_postings SET closed_at = ? WHERE business_id = ? AND closed_at IS NULL AND last_seen_at < ?`)
    .bind(nowIso, businessId, nowIso).run()).meta.changes ?? 0;
  return { added, closed };
}

export async function closeAll(db: D1Database, businessId: string, nowIso: string): Promise<number> {
  return (await db.prepare(`UPDATE job_postings SET closed_at = ? WHERE business_id = ? AND closed_at IS NULL`).bind(nowIso, businessId).run()).meta.changes ?? 0;
}

/** Open roles first (in-field before off-field, so the limit never drops an in-field role), then closed ones, each newest first. */
export async function listPostingsForLead(db: D1Database, businessId: string, limit = 50): Promise<JobPosting[]> {
  return (await db.prepare(`SELECT * FROM job_postings WHERE business_id = ? ORDER BY closed_at IS NOT NULL, role_kind IS NULL, COALESCE(posted_at, first_seen_at) DESC, id LIMIT ?`)
    .bind(businessId, limit).all<PostingRow>()).results.map(toPosting);
}

export async function openRelevantByBusiness(db: D1Database, ids: string[]): Promise<Map<string, JobPosting[]>> {
  const out = new Map<string, JobPosting[]>();
  for (const part of chunks(ids)) {
    const rows = (await db.prepare(
      `SELECT * FROM job_postings WHERE closed_at IS NULL AND role_kind IS NOT NULL AND business_id IN (${part.map(() => "?").join(",")})`,
    ).bind(...part).all<PostingRow>()).results;
    for (const r of rows) {
      const p = toPosting(r), list = out.get(p.business_id) ?? [];
      list.push(p); out.set(p.business_id, list);
    }
  }
  return out;
}

export type OpenRole = JobPosting & { business_name: string; domain: string | null; place_id: string | null; website_url: string | null };

/** Open roles in the field across all non-archived leads, newest first. The caller filters suppressed leads. */
export async function listOpenRelevantWithBusiness(db: D1Database, limit: number): Promise<OpenRole[]> {
  return (await db.prepare(
    `SELECT j.*, b.name AS business_name, b.domain, b.place_id, b.website_url FROM job_postings j JOIN businesses b ON b.id = j.business_id
     WHERE j.closed_at IS NULL AND j.role_kind IS NOT NULL AND b.archived_at IS NULL
     ORDER BY COALESCE(j.posted_at, j.first_seen_at) DESC, j.id LIMIT ?`,
  ).bind(limit).all<PostingRow & Pick<OpenRole, "business_name" | "domain" | "place_id" | "website_url">>()).results.map((r) => ({ ...toPosting(r), business_name: r.business_name, domain: r.domain, place_id: r.place_id, website_url: r.website_url }));
}

/** The role a draft may cite for this lead (see pickRole): open, in the field, seen within SEEN_WITHIN_HOURS, best kind first. */
export async function bestOpenPosting(db: D1Database, businessId: string, nowIso: string, order: RoleKind[]): Promise<JobPosting | null> {
  const since = new Date(Date.parse(nowIso) - SEEN_WITHIN_HOURS * 3_600_000).toISOString();
  const rows = (await db.prepare(`SELECT * FROM job_postings WHERE business_id = ? AND closed_at IS NULL AND role_kind IS NOT NULL AND last_seen_at >= ?`)
    .bind(businessId, since).all<PostingRow>()).results.map(toPosting);
  return pickRole(rows, order, Date.parse(nowIso));
}

/** Postings by id, for rechecking what drafts cite. An id with no row (the lead was rebuilt, say) is simply absent. */
export async function postingsByIds(db: D1Database, ids: string[]): Promise<Map<string, JobPosting>> {
  const out = new Map<string, JobPosting>();
  for (const part of chunks([...new Set(ids)]))
    for (const r of (await db.prepare(`SELECT * FROM job_postings WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<PostingRow>()).results) out.set(r.id, toPosting(r));
  return out;
}

/** The role a draft cites and whether it can still be claimed. `warning` is set exactly when it cannot, worded for the owner. */
export interface CitedRole { id: string; title: string | null; url: string | null; state: PostingState; warning: string | null }

export async function citedRole(db: D1Database, d: { posting_id: string | null }, nowMs: number): Promise<CitedRole | null> {
  if (!d.posting_id) return null;
  const p = (await postingsByIds(db, [d.posting_id])).get(d.posting_id) ?? null;
  const state = p ? postingState(p, nowMs) : "closed", name = p ? `"${p.title}"` : "a role";
  const warning = state === "open" ? null
    : state === "closed" ? `This draft says they're hiring for ${name}, but that role has closed.`
    : `This draft says they're hiring for ${name}, but their board hasn't shown it in the last ${SEEN_WITHIN_HOURS} hours, so it may be closed.`;
  return { id: d.posting_id, title: p?.title ?? null, url: p?.url ?? null, state, warning };
}
