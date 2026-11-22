// Local SEO reports data (Plan 14): the monthly report of a client, the same shape and rules as the Care report (Plan 13) plus up to three priorities for the month ahead.
// Times are UTC ISO strings with milliseconds. A report's `facts` are a JSON snapshot taken when it is made; every state change is one compare-and-set statement.
import type { ReportStatus, SummarySource } from "./careReports";

export type SeoReportStatus = ReportStatus;
export type SeoSummarySource = SummarySource;

export interface SeoReport {
  id: string; businessId: string; period: string; status: SeoReportStatus; token: string;
  /** The snapshot of facts (typed by the report builder; read back as parsed JSON, or null when unreadable). */
  facts: unknown;
  summary: string; recommendation: string;
  /** What to work on next month: none (a plain summary has no priorities) or Claude's / Logan's list of up to three. */
  priorities: string[];
  summarySource: SeoSummarySource; claudeTaskId: string | null; approvalId: string | null; test: boolean;
  createdAt: string; readyAt: string | null; sentAt: string | null; firstViewedAt: string | null; viewCount: number; revokedAt: string | null;
}

interface Row {
  id: string; business_id: string; period: string; status: SeoReportStatus; token: string; facts: string; summary: string; recommendation: string; priorities: string; summary_source: SeoSummarySource;
  claude_task_id: string | null; approval_id: string | null; test: number; created_at: string; ready_at: string | null; sent_at: string | null; first_viewed_at: string | null;
  view_count: number; revoked_at: string | null;
}

const parseList = (s: string): string[] => {
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

const toReport = (r: Row): SeoReport => {
  let facts: unknown = null;
  try { facts = JSON.parse(r.facts); } catch { /* an unreadable snapshot is null */ }
  return {
    id: r.id, businessId: r.business_id, period: r.period, status: r.status, token: r.token, facts, summary: r.summary, recommendation: r.recommendation, priorities: parseList(r.priorities),
    summarySource: r.summary_source, claudeTaskId: r.claude_task_id, approvalId: r.approval_id, test: !!r.test, createdAt: r.created_at, readyAt: r.ready_at, sentAt: r.sent_at,
    firstViewedAt: r.first_viewed_at, viewCount: r.view_count, revokedAt: r.revoked_at,
  };
};

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const changed = (res: { meta: { changes?: number } }) => (res.meta.changes ?? 0) === 1;

export async function getSeoReport(db: D1Database, id: string): Promise<SeoReport | null> {
  const r = await db.prepare(`SELECT * FROM seo_reports WHERE id = ?`).bind(id).first<Row>();
  return r ? toReport(r) : null;
}

export async function getSeoReportByToken(db: D1Database, token: string): Promise<SeoReport | null> {
  const r = await db.prepare(`SELECT * FROM seo_reports WHERE token = ?`).bind(token).first<Row>();
  return r ? toReport(r) : null;
}

export async function getSeoReportFor(db: D1Database, businessId: string, period: string): Promise<SeoReport | null> {
  const r = await db.prepare(`SELECT * FROM seo_reports WHERE business_id = ? AND period = ?`).bind(businessId, period).first<Row>();
  return r ? toReport(r) : null;
}

/** Reports of one period, of one client and/or in any of the given statuses (an empty status list matches none), oldest first. */
export async function listSeoReports(db: D1Database, o: { period?: string; businessId?: string; status?: SeoReportStatus[] }): Promise<SeoReport[]> {
  if (o.status && o.status.length === 0) return [];
  const where: string[] = [];
  const args: string[] = [];
  if (o.period !== undefined) { where.push("period = ?"); args.push(o.period); }
  if (o.businessId !== undefined) { where.push("business_id = ?"); args.push(o.businessId); }
  if (o.status) { where.push(`status IN (${marks(o.status.length)})`); args.push(...o.status); }
  const rows = (await db.prepare(`SELECT * FROM seo_reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`).bind(...args).all<Row>()).results;
  return rows.map(toReport);
}

/** Makes the report of a client's period, once: a second call (or a racing one) changes nothing and returns the row that is there, with `created: false`. */
export async function insertSeoReport(
  db: D1Database, o: { businessId: string; period: string; token: string; facts: unknown; test: boolean; now: string },
): Promise<{ report: SeoReport; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO seo_reports (id, business_id, period, status, token, facts, test, created_at) VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?) ON CONFLICT (business_id, period) DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), o.businessId, o.period, o.token, JSON.stringify(o.facts), o.test ? 1 : 0, o.now).first<Row>();
  if (made) return { report: toReport(made), created: true };
  const existing = await getSeoReportFor(db, o.businessId, o.period);
  if (!existing) throw new Error("could not make the SEO report");
  return { report: existing, created: false };
}

/**
 * Sets the summary, recommendation and priorities while the report is in one of the `from` statuses, and makes it `ready` (stamping `ready_at` the first time).
 * One statement, so two callers cannot both win; false when the report was not in any of them.
 */
export async function setSeoSummary(
  db: D1Database, id: string, from: SeoReportStatus[], o: { summary: string; recommendation: string; priorities: string[]; source: SeoSummarySource; now: string },
): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(
    `UPDATE seo_reports SET summary = ?, recommendation = ?, priorities = ?, summary_source = ?, status = 'ready', ready_at = COALESCE(ready_at, ?) WHERE id = ? AND status IN (${marks(from.length)})`,
  ).bind(o.summary, o.recommendation, JSON.stringify(o.priorities), o.source, o.now, id, ...from).run();
  return changed(res);
}

/** Logan's edit of the words, only while the report is `ready`; the text is then his. Priorities left out are not touched. */
export async function editSeoSummary(db: D1Database, id: string, o: { summary: string; recommendation: string; priorities?: string[] }): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE seo_reports SET summary = ?, recommendation = ?, priorities = CASE WHEN ? = 1 THEN ? ELSE priorities END, summary_source = 'logan' WHERE id = ? AND status = 'ready'`,
  ).bind(o.summary, o.recommendation, o.priorities !== undefined ? 1 : 0, JSON.stringify(o.priorities ?? []), id).run();
  return changed(res);
}

/** Links the Claude job and the approval that go with the report; a field left out is not touched. */
export async function setSeoTaskAndApproval(db: D1Database, id: string, patch: { claudeTaskId?: string; approvalId?: string }): Promise<void> {
  await db.prepare(
    `UPDATE seo_reports SET claude_task_id = CASE WHEN ? = 1 THEN ? ELSE claude_task_id END, approval_id = CASE WHEN ? = 1 THEN ? ELSE approval_id END WHERE id = ?`,
  ).bind(patch.claudeTaskId !== undefined ? 1 : 0, patch.claudeTaskId ?? null, patch.approvalId !== undefined ? 1 : 0, patch.approvalId ?? null, id).run();
}

/** `ready` to `sent`; false when it was not ready (so a second send changes nothing). */
export async function markSeoSent(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE seo_reports SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'ready'`).bind(now, id).run());
}

/** Takes a report back: `ready` or `sent` to `revoked`; its link stops working. */
export async function revokeSeoReport(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE seo_reports SET status = 'revoked', revoked_at = ? WHERE id = ? AND status IN ('ready', 'sent')`).bind(now, id).run());
}

/** Drops a report that was never sent: `collecting` or `ready` to `cancelled`. */
export async function cancelSeoReport(db: D1Database, id: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE seo_reports SET status = 'cancelled' WHERE id = ? AND status IN ('collecting', 'ready')`).bind(id).run());
}

/** Counts one view of the report page; the first view time is kept from the first call. */
export async function recordSeoView(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE seo_reports SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?) WHERE id = ?`).bind(now, id).run();
}
