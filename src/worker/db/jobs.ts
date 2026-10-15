import type { CareerSource, JobPosting, RoleKind } from "../types";
import { chunks } from "./chunks";

/** A board is only trusted for what it showed us recently: a role not seen for this long is not "open" for outreach purposes. */
export const SEEN_WITHIN_HOURS = 48;

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

export async function listDueSources(db: D1Database, nowIso: string, limit: number): Promise<CareerSource[]> {
  return (await db.prepare(`SELECT * FROM career_sources WHERE status = 'active' AND next_check_at <= ? ORDER BY next_check_at, business_id LIMIT ?`)
    .bind(nowIso, limit).all<CareerSource>()).results;
}

/** Scanned, non-archived leads with a website that have no board record yet, or whose "none"/"error" record is due for another look. */
export async function listUndiscovered(db: D1Database, nowIso: string, limit: number): Promise<{ id: string }[]> {
  return (await db.prepare(
    `SELECT b.id FROM businesses b
     WHERE b.archived_at IS NULL AND b.website_url IS NOT NULL
       AND EXISTS (SELECT 1 FROM audits a WHERE a.business_id = b.id)
       AND (NOT EXISTS (SELECT 1 FROM career_sources s WHERE s.business_id = b.id)
            OR EXISTS (SELECT 1 FROM career_sources s WHERE s.business_id = b.id AND s.status IN ('none','error') AND s.next_check_at <= ?))
     ORDER BY b.created_at, b.id LIMIT ?`,
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

/** Open roles first, then closed ones, each newest first. */
export async function listPostingsForLead(db: D1Database, businessId: string, limit = 50): Promise<JobPosting[]> {
  return (await db.prepare(`SELECT * FROM job_postings WHERE business_id = ? ORDER BY closed_at IS NOT NULL, COALESCE(posted_at, first_seen_at) DESC LIMIT ?`)
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

/** The newest open role in the field that the board showed us in the last SEEN_WITHIN_HOURS, or null. */
export async function bestOpenPosting(db: D1Database, businessId: string, nowIso: string): Promise<JobPosting | null> {
  const since = new Date(Date.parse(nowIso) - SEEN_WITHIN_HOURS * 3_600_000).toISOString();
  const r = await db.prepare(
    `SELECT * FROM job_postings WHERE business_id = ? AND closed_at IS NULL AND role_kind IS NOT NULL AND last_seen_at >= ?
     ORDER BY COALESCE(posted_at, first_seen_at) DESC, id LIMIT 1`,
  ).bind(businessId, since).first<PostingRow>();
  return r ? toPosting(r) : null;
}
