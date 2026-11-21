// Care reports data (Plan 13): the monthly report of a client, and the per-day uptime counts it is built from.
// Times are UTC ISO strings with milliseconds. A report's `facts` are a JSON snapshot taken when it is made; every state change is one compare-and-set statement.

export type ReportStatus = "collecting" | "ready" | "sent" | "revoked" | "cancelled";
export type SummarySource = "none" | "claude" | "plain" | "logan";

export interface CareReport {
  id: string; businessId: string; period: string; status: ReportStatus; token: string;
  /** The snapshot of facts (typed by the report builder; read back as parsed JSON, or null when unreadable). */
  facts: unknown;
  summary: string; recommendation: string; summarySource: SummarySource; claudeTaskId: string | null; approvalId: string | null; test: boolean;
  createdAt: string; readyAt: string | null; sentAt: string | null; firstViewedAt: string | null; viewCount: number; revokedAt: string | null;
}

interface Row {
  id: string; business_id: string; period: string; status: ReportStatus; token: string; facts: string; summary: string; recommendation: string; summary_source: SummarySource;
  claude_task_id: string | null; approval_id: string | null; test: number; created_at: string; ready_at: string | null; sent_at: string | null; first_viewed_at: string | null;
  view_count: number; revoked_at: string | null;
}

const toReport = (r: Row): CareReport => {
  let facts: unknown = null;
  try { facts = JSON.parse(r.facts); } catch { /* an unreadable snapshot is null */ }
  return {
    id: r.id, businessId: r.business_id, period: r.period, status: r.status, token: r.token, facts, summary: r.summary, recommendation: r.recommendation, summarySource: r.summary_source,
    claudeTaskId: r.claude_task_id, approvalId: r.approval_id, test: !!r.test, createdAt: r.created_at, readyAt: r.ready_at, sentAt: r.sent_at, firstViewedAt: r.first_viewed_at,
    viewCount: r.view_count, revokedAt: r.revoked_at,
  };
};

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const changed = (res: { meta: { changes?: number } }) => (res.meta.changes ?? 0) === 1;

export async function getReport(db: D1Database, id: string): Promise<CareReport | null> {
  const r = await db.prepare(`SELECT * FROM care_reports WHERE id = ?`).bind(id).first<Row>();
  return r ? toReport(r) : null;
}

export async function getReportByToken(db: D1Database, token: string): Promise<CareReport | null> {
  const r = await db.prepare(`SELECT * FROM care_reports WHERE token = ?`).bind(token).first<Row>();
  return r ? toReport(r) : null;
}

export async function getReportFor(db: D1Database, businessId: string, period: string): Promise<CareReport | null> {
  const r = await db.prepare(`SELECT * FROM care_reports WHERE business_id = ? AND period = ?`).bind(businessId, period).first<Row>();
  return r ? toReport(r) : null;
}

/** Reports of one period and/or in any of the given statuses (an empty status list matches none), oldest first. */
export async function listReports(db: D1Database, o: { period?: string; status?: ReportStatus[] }): Promise<CareReport[]> {
  if (o.status && o.status.length === 0) return [];
  const where: string[] = [];
  const args: string[] = [];
  if (o.period !== undefined) { where.push("period = ?"); args.push(o.period); }
  if (o.status) { where.push(`status IN (${marks(o.status.length)})`); args.push(...o.status); }
  const rows = (await db.prepare(`SELECT * FROM care_reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`).bind(...args).all<Row>()).results;
  return rows.map(toReport);
}

/** Makes the report of a client's period, once: a second call (or a racing one) changes nothing and returns the row that is there, with `created: false`. */
export async function insertReport(
  db: D1Database, o: { businessId: string; period: string; token: string; facts: unknown; test: boolean; now: string },
): Promise<{ report: CareReport; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO care_reports (id, business_id, period, status, token, facts, test, created_at) VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?) ON CONFLICT (business_id, period) DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), o.businessId, o.period, o.token, JSON.stringify(o.facts), o.test ? 1 : 0, o.now).first<Row>();
  if (made) return { report: toReport(made), created: true };
  const existing = await getReportFor(db, o.businessId, o.period);
  if (!existing) throw new Error("could not make the care report");
  return { report: existing, created: false };
}

/**
 * Sets the summary and recommendation while the report is in one of the `from` statuses, and makes it `ready` (stamping `ready_at` the first time).
 * One statement, so two callers cannot both win; false when the report was not in any of them.
 */
export async function setSummary(
  db: D1Database, id: string, from: ReportStatus[], o: { summary: string; recommendation: string; source: SummarySource; now: string },
): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(
    `UPDATE care_reports SET summary = ?, recommendation = ?, summary_source = ?, status = 'ready', ready_at = COALESCE(ready_at, ?) WHERE id = ? AND status IN (${marks(from.length)})`,
  ).bind(o.summary, o.recommendation, o.source, o.now, id, ...from).run();
  return changed(res);
}

/** Logan's edit of the words, only while the report is `ready`; the text is then his. */
export async function editSummary(db: D1Database, id: string, o: { summary: string; recommendation: string }): Promise<boolean> {
  const res = await db.prepare(`UPDATE care_reports SET summary = ?, recommendation = ?, summary_source = 'logan' WHERE id = ? AND status = 'ready'`).bind(o.summary, o.recommendation, id).run();
  return changed(res);
}

/** Links the Claude job and the approval that go with the report; a field left out is not touched. */
export async function setTaskAndApproval(db: D1Database, id: string, patch: { claudeTaskId?: string; approvalId?: string }): Promise<void> {
  await db.prepare(
    `UPDATE care_reports SET claude_task_id = CASE WHEN ? = 1 THEN ? ELSE claude_task_id END, approval_id = CASE WHEN ? = 1 THEN ? ELSE approval_id END WHERE id = ?`,
  ).bind(patch.claudeTaskId !== undefined ? 1 : 0, patch.claudeTaskId ?? null, patch.approvalId !== undefined ? 1 : 0, patch.approvalId ?? null, id).run();
}

/** `ready` to `sent`; false when it was not ready (so a second send changes nothing). */
export async function markSent(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE care_reports SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'ready'`).bind(now, id).run());
}

/** Takes a report back: `ready` or `sent` to `revoked`; its link stops working. */
export async function revoke(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE care_reports SET status = 'revoked', revoked_at = ? WHERE id = ? AND status IN ('ready', 'sent')`).bind(now, id).run());
}

/** Drops a report that was never sent: `collecting` or `ready` to `cancelled`. */
export async function cancel(db: D1Database, id: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE care_reports SET status = 'cancelled' WHERE id = ? AND status IN ('collecting', 'ready')`).bind(id).run());
}

/** Counts one view of the report page; the first view time is kept from the first call. */
export async function recordView(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE care_reports SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?) WHERE id = ?`).bind(now, id).run();
}

// --- uptime days ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Saves the checks of one site on one day (the booking-zone local date); a second call for the day replaces the numbers. */
export async function upsertUptimeDay(db: D1Database, siteId: string, day: string, checks: number, okChecks: number): Promise<void> {
  await db.prepare(
    `INSERT INTO site_uptime_days (site_id, day, checks, ok_checks) VALUES (?, ?, ?, ?) ON CONFLICT (site_id, day) DO UPDATE SET checks = excluded.checks, ok_checks = excluded.ok_checks`,
  ).bind(siteId, day, checks, okChecks).run();
}

/** The site's days from `fromDay` to `toDay`, both included, in day order. */
export async function uptimeDays(db: D1Database, siteId: string, fromDay: string, toDay: string): Promise<{ day: string; checks: number; okChecks: number }[]> {
  const rows = (await db.prepare(`SELECT day, checks, ok_checks FROM site_uptime_days WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day`).bind(siteId, fromDay, toDay).all<{ day: string; checks: number; ok_checks: number }>()).results;
  return rows.map((r) => ({ day: r.day, checks: r.checks, okChecks: r.ok_checks }));
}
