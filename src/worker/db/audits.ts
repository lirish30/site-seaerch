import type { Audit, AuditInsert } from "../types";
import { chunks } from "./chunks";

type Row = Omit<Audit, "findings" | "partial" | "mobile_friendly" | "https" | "has_title" | "has_meta_description" | "has_contact_form"> & {
  findings: string; partial: number; mobile_friendly: number | null; https: number | null;
  has_title: number | null; has_meta_description: number | null; has_contact_form: number | null;
};
const b = (v: number | null) => (v === null ? null : v === 1);
const n = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

function fromRow(r: Row): Audit {
  return {
    ...r, findings: JSON.parse(r.findings), partial: r.partial === 1, mobile_friendly: b(r.mobile_friendly),
    https: b(r.https), has_title: b(r.has_title), has_meta_description: b(r.has_meta_description),
    has_contact_form: b(r.has_contact_form),
  };
}

export async function insertAudit(db: D1Database, a: AuditInsert): Promise<Audit> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO audits (id, business_id, created_at, site_status, partial, pagespeed_mobile, lcp_ms, cls,
     mobile_friendly, https, has_title, has_meta_description, has_contact_form, copyright_year,
     latest_content_date, broken_link_count, platform, seo_score, accessibility_score, score, offer, findings, raw_r2_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, a.business_id, new Date().toISOString(), a.site_status, a.partial ? 1 : 0, a.pagespeed_mobile,
    a.lcp_ms, a.cls, n(a.mobile_friendly), n(a.https), n(a.has_title), n(a.has_meta_description),
    n(a.has_contact_form), a.copyright_year, a.latest_content_date, a.broken_link_count, a.platform, a.seo_score, a.accessibility_score, a.score, a.offer,
    JSON.stringify(a.findings), a.raw_r2_key).run();
  return (await db.prepare(`SELECT * FROM audits WHERE id = ?`).bind(id).first<Row>().then((r) => fromRow(r!)));
}

export async function latestAudit(db: D1Database, businessId: string): Promise<Audit | null> {
  const r = await db.prepare(`SELECT * FROM audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** Latest audit per business, fetched in one query per chunk of ids. */
export async function latestAuditsFor(db: D1Database, businessIds: string[]): Promise<Map<string, Audit>> {
  const out = new Map<string, Audit>();
  for (const ids of chunks([...new Set(businessIds)])) {
    const rows = (await db.prepare(
      `SELECT a.* FROM audits a WHERE a.business_id IN (${ids.map(() => "?").join(",")})
       AND a.created_at = (SELECT MAX(created_at) FROM audits WHERE business_id = a.business_id)`,
    ).bind(...ids).all<Row>()).results;
    for (const r of rows) if (!out.has(r.business_id)) out.set(r.business_id, fromRow(r));
  }
  return out;
}
