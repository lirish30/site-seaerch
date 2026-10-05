import type { Audit, AuditInsert, Finding } from "../types";
import { chunks } from "./chunks";

type JsonCols = "findings" | "category_scores" | "ai_review" | "screenshots" | "site_links";
type Row = Omit<Audit, JsonCols | "partial" | "mobile_friendly" | "https" | "has_title" | "has_meta_description" | "has_contact_form"> & {
  findings: string; category_scores: string | null; ai_review: string | null; screenshots: string | null; site_links: string | null;
  partial: number; mobile_friendly: number | null; https: number | null;
  has_title: number | null; has_meta_description: number | null; has_contact_form: number | null;
};
const b = (v: number | null) => (v === null ? null : v === 1);
const n = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
const json = <T,>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// v1 findings carried {group: speed|stale|basics|seo|local, severity: high|medium|low} and no recommendation.
const V1_CATEGORY: Record<string, Finding["category"]> = { speed: "speed", stale: "content", basics: "technical", seo: "technical", local: "cro", site: "site" };
const V1_SEVERITY: Record<string, Finding["severity"]> = { high: "critical", medium: "important", low: "nice" };
function normalizeFinding(f: any): Finding {
  if (f.category) return f as Finding;
  const category = f.code === "not_mobile_friendly" ? "mobile" : f.code === "no_contact_form" ? "cro" : V1_CATEGORY[f.group] ?? "technical";
  return { code: f.code, category, severity: V1_SEVERITY[f.severity] ?? "nice", points: f.points ?? 0,
    evidence: f.evidence ?? "", recommendation: "", source: "rule" };
}

function fromRow(r: Row): Audit {
  return {
    ...r, findings: json<any[]>(r.findings, []).map(normalizeFinding), partial: r.partial === 1, mobile_friendly: b(r.mobile_friendly),
    https: b(r.https), has_title: b(r.has_title), has_meta_description: b(r.has_meta_description),
    has_contact_form: b(r.has_contact_form), health_score: r.health_score ?? null, niche: r.niche ?? null,
    category_scores: json(r.category_scores, {}), ai_review: json(r.ai_review, null),
    screenshots: { desktop: null, mobile: null, ...json(r.screenshots, {}) }, site_links: json(r.site_links, {}),
    platform: r.platform ?? null, seo_score: r.seo_score ?? null, accessibility_score: r.accessibility_score ?? null,
    mail_warning: r.mail_warning ?? null,
  };
}

export async function insertAudit(db: D1Database, a: AuditInsert): Promise<Audit> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO audits (id, business_id, created_at, site_status, partial, pagespeed_mobile, lcp_ms, cls,
     mobile_friendly, https, has_title, has_meta_description, has_contact_form, copyright_year,
     latest_content_date, broken_link_count, score, offer, findings, raw_r2_key,
     health_score, niche, category_scores, ai_review, screenshots, site_links,
     platform, seo_score, accessibility_score, mail_warning)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, a.business_id, new Date().toISOString(), a.site_status, a.partial ? 1 : 0, a.pagespeed_mobile,
    a.lcp_ms, a.cls, n(a.mobile_friendly), n(a.https), n(a.has_title), n(a.has_meta_description),
    n(a.has_contact_form), a.copyright_year, a.latest_content_date, a.broken_link_count, a.score, a.offer,
    JSON.stringify(a.findings), a.raw_r2_key, a.health_score, a.niche, JSON.stringify(a.category_scores),
    a.ai_review ? JSON.stringify(a.ai_review) : null, JSON.stringify(a.screenshots), JSON.stringify(a.site_links),
    a.platform, a.seo_score, a.accessibility_score, a.mail_warning).run();
  return (await db.prepare(`SELECT * FROM audits WHERE id = ?`).bind(id).first<Row>().then((r) => fromRow(r!)));
}

export async function latestAudit(db: D1Database, businessId: string): Promise<Audit | null> {
  const r = await db.prepare(`SELECT * FROM audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** Audit history for a business, newest first. */
export async function listAudits(db: D1Database, businessId: string, limit = 20): Promise<Audit[]> {
  const rows = (await db.prepare(`SELECT * FROM audits WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(businessId, limit).all<Row>()).results;
  return rows.map(fromRow);
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
