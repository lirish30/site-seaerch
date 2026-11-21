import { CARE_KEYS, LIVE, testClientSql } from "../clients/record";
import { getSite, toSite, type Site, type SiteRow } from "./sites";

// Care monitoring data (Plan 11): the probe's checks, the incidents they open and close, and which sites are watched.
// Times are UTC ISO strings with milliseconds. No secret is stored: a check keeps a status, a time and a short error word, never a body or a header.

export type IncidentKind = "down" | "domain_expiring" | "update_failed" | "cert_expiring";

export interface SiteCheck { id: string; siteId: string; checkedAt: string; ok: boolean; status: number | null; ms: number | null; error: string | null }
export interface Incident { id: string; siteId: string; businessId: string; kind: IncidentKind; openedAt: string; closedAt: string | null; detail: string }

interface CheckRow { id: string; site_id: string; checked_at: string; ok: number; status: number | null; ms: number | null; error: string | null }
interface IncidentRow { id: string; site_id: string; business_id: string; kind: IncidentKind; opened_at: string; closed_at: string | null; detail: string }

const toCheck = (r: CheckRow): SiteCheck => ({ id: r.id, siteId: r.site_id, checkedAt: r.checked_at, ok: !!r.ok, status: r.status, ms: r.ms, error: r.error });
const toIncident = (r: IncidentRow): Incident => ({
  id: r.id, siteId: r.site_id, businessId: r.business_id, kind: r.kind, openedAt: r.opened_at, closedAt: r.closed_at, detail: r.detail,
});

export async function insertCheck(db: D1Database, c: Omit<SiteCheck, "id">): Promise<void> {
  await db.prepare(`INSERT INTO site_checks (id, site_id, checked_at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), c.siteId, c.checkedAt, c.ok ? 1 : 0, c.status, c.ms, c.error).run();
}

/** The site's latest checks, newest first. */
export async function recentChecks(db: D1Database, siteId: string, limit: number): Promise<SiteCheck[]> {
  const rows = (await db.prepare(`SELECT * FROM site_checks WHERE site_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?`).bind(siteId, limit).all<CheckRow>()).results;
  return rows.map(toCheck);
}

/**
 * The site's latest `limit` distinct check times, newest first, each with whether any check at that time was ok. Checks written with the same time (a cron run that fired twice) are one moment, not two.
 */
export async function recentOutcomes(db: D1Database, siteId: string, limit: number): Promise<{ checkedAt: string; ok: boolean }[]> {
  const rows = (await db.prepare(
    `SELECT checked_at, MAX(ok) AS ok FROM site_checks WHERE site_id = ? GROUP BY checked_at ORDER BY checked_at DESC LIMIT ?`,
  ).bind(siteId, limit).all<{ checked_at: string; ok: number }>()).results;
  return rows.map((r) => ({ checkedAt: r.checked_at, ok: !!r.ok }));
}

/** The share of checks since `sinceIso` (inclusive) that were ok, to one decimal; `percent` is null when there were none. */
export async function uptimePercent(db: D1Database, siteId: string, sinceIso: string): Promise<{ percent: number | null; checks: number }> {
  const r = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM site_checks WHERE site_id = ? AND checked_at >= ?`).bind(siteId, sinceIso).first<{ n: number; ok: number }>();
  const n = r?.n ?? 0;
  return n === 0 ? { percent: null, checks: 0 } : { percent: Math.round(((r!.ok * 100) / n) * 10) / 10, checks: n };
}

/** Deletes the checks made before `beforeIso`; returns how many went. */
export async function pruneChecks(db: D1Database, beforeIso: string): Promise<number> {
  const res = await db.prepare(`DELETE FROM site_checks WHERE checked_at < ?`).bind(beforeIso).run();
  return res.meta.changes ?? 0;
}

/**
 * Opens an incident for the site and kind. At most one is open at a time (a unique index): when one already is, nothing changes and `created` is false.
 * One INSERT ... ON CONFLICT DO NOTHING RETURNING: the row that comes back is the one this call made. On a conflict the open one is read; if it was closed in between (a race), the insert is tried once more.
 */
export async function openIncident(
  db: D1Database, i: { siteId: string; businessId: string; kind: IncidentKind; detail: string; now: string },
): Promise<{ incident: Incident; created: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = await db.prepare(
      `INSERT INTO site_incidents (id, site_id, business_id, kind, opened_at, closed_at, detail) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING RETURNING *`,
    ).bind(crypto.randomUUID(), i.siteId, i.businessId, i.kind, i.now, i.detail).first<IncidentRow>();
    if (made) return { incident: toIncident(made), created: true };
    const open = await db.prepare(`SELECT * FROM site_incidents WHERE site_id = ? AND kind = ? AND closed_at IS NULL`).bind(i.siteId, i.kind).first<IncidentRow>();
    if (open) return { incident: toIncident(open), created: false };
  }
  throw new Error("could not open the incident");
}

/** One incident by id (open or closed), or null. */
export async function getIncident(db: D1Database, id: string): Promise<Incident | null> {
  const r = await db.prepare(`SELECT * FROM site_incidents WHERE id = ?`).bind(id).first<IncidentRow>();
  return r ? toIncident(r) : null;
}

/** Closes the open incident for the site and kind and returns it as closed; null when none was open. One statement, so two closers cannot both win. */
export async function closeIncident(db: D1Database, siteId: string, kind: IncidentKind, now: string): Promise<Incident | null> {
  const row = await db.prepare(`UPDATE site_incidents SET closed_at = ? WHERE site_id = ? AND kind = ? AND closed_at IS NULL RETURNING *`).bind(now, siteId, kind).first<IncidentRow>();
  return row ? toIncident(row) : null;
}

/** Incidents newest first (default 50). Test clients, test sites, archived sites and sites with no address are left out (the same sites the Care board shows), so a limit counts only what is shown. `open` true keeps the ones still open, false the closed ones. */
export async function listIncidents(db: D1Database, o: { businessId?: string; open?: boolean; limit?: number }): Promise<Incident[]> {
  const where: string[] = [`s.test = 0`, `s.archived_at IS NULL`, `s.url IS NOT NULL`, `s.url <> ''`, `NOT ${testClientSql("b")}`], binds: unknown[] = [];
  if (o.businessId !== undefined) { where.push("i.business_id = ?"); binds.push(o.businessId); }
  if (o.open === true) where.push("i.closed_at IS NULL");
  if (o.open === false) where.push("i.closed_at IS NOT NULL");
  const rows = (await db.prepare(
    `SELECT i.* FROM site_incidents i JOIN sites s ON s.id = i.site_id JOIN businesses b ON b.id = i.business_id
     WHERE ${where.join(" AND ")} ORDER BY i.opened_at DESC, i.rowid DESC LIMIT ?`,
  ).bind(...binds, o.limit ?? 50).all<IncidentRow>()).results;
  return rows.map(toIncident);
}

/** The open incidents of these businesses (at most IN_CHUNK ids per call), newest first. Not filtered by site: the caller keeps the ones whose site is on its list. */
export async function openIncidentsFor(db: D1Database, businessIds: string[]): Promise<Incident[]> {
  if (businessIds.length === 0) return [];
  const rows = (await db.prepare(
    `SELECT * FROM site_incidents WHERE business_id IN (${businessIds.map(() => "?").join(",")}) AND closed_at IS NULL ORDER BY opened_at DESC, rowid DESC`,
  ).bind(...businessIds).all<IncidentRow>()).results;
  return rows.map(toIncident);
}

/** Records the domain's expiry date (YYYY-MM-DD, or null when it could not be found) and when it was looked up. */
export async function setDomainExpiry(db: D1Database, siteId: string, expiresOn: string | null, checkedAt: string): Promise<void> {
  await db.prepare(`UPDATE sites SET domain_expires_on = ?, domain_checked_at = ? WHERE id = ?`).bind(expiresOn, checkedAt, siteId).run();
}

/** Records the TLS certificate's expiry date (YYYY-MM-DD) and when the helper read it. */
export async function setCertExpiry(db: D1Database, siteId: string, expiresOn: string, checkedAt: string): Promise<void> {
  await db.prepare(`UPDATE sites SET cert_expires_on = ?, cert_checked_at = ? WHERE id = ?`).bind(expiresOn, checkedAt, siteId).run();
}

/** Turns monitoring on or off for a site by hand. Returns the site, or null when it is unknown. */
export async function setMonitoring(db: D1Database, siteId: string, on: boolean, now: string): Promise<Site | null> {
  await db.prepare(`UPDATE sites SET monitoring = ?, updated_at = ? WHERE id = ?`).bind(on ? 1 : 0, now, siteId).run();
  return getSite(db, siteId);
}

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

/** True for the business (alias `a`) when it has a real Care subscription that is billing or late on a bill: the same rule `careLabel` uses. */
export const CARE_SUBSCRIPTION_SQL = (a: string): string =>
  `EXISTS (SELECT 1 FROM subscriptions cs WHERE cs.business_id = ${a}.id AND cs.test = 0 AND cs.status IN (${list(LIVE)}) AND cs.package_key IN (${list(CARE_KEYS)}))`;

/**
 * SQL true for the site (alias `s`) of the business (alias `b`) when the probe watches it: real and live, with an address, never a test client's, and either switched on by hand or
 * belonging to a client with live Care. The one statement of this rule: `monitoredSites`, the close step below and the Care board all use it.
 */
export const monitoredSiteSql = (s: string, b: string): string =>
  `(${s}.test = 0 AND ${s}.archived_at IS NULL AND ${s}.url IS NOT NULL AND ${s}.url <> '' AND NOT ${testClientSql(b)} AND (${s}.monitoring = 1 OR ${CARE_SUBSCRIPTION_SQL(b)}))`;

/**
 * The sites the probe should check (see `monitoredSiteSql`). The site checked longest ago comes first (one never checked before all), at most `limit`.
 */
export async function monitoredSites(db: D1Database, limit: number): Promise<Site[]> {
  const rows = (await db.prepare(
    `SELECT s.* FROM sites s JOIN businesses b ON b.id = s.business_id
     WHERE ${monitoredSiteSql("s", "b")}
     ORDER BY (SELECT MAX(c.checked_at) FROM site_checks c WHERE c.site_id = s.id) ASC, s.created_at, s.id
     LIMIT ?`,
  ).bind(limit).all<SiteRow>()).results;
  return rows.map(toSite);
}

/**
 * Closes, silently (no activity line: nothing came back, the watching just stopped), every open incident whose site is not watched any more: Care ended, the switch is off, the address
 * was cleared, the site was archived or marked test. One statement, so it is safe to run on every tick and when two runs overlap; an incident of a watched site is never touched.
 * `siteId` narrows it to one site (the switch route). Returns how many incidents it closed.
 */
export async function closeUnmonitoredIncidents(db: D1Database, now: string, siteId?: string): Promise<number> {
  const res = await db.prepare(
    `UPDATE site_incidents SET closed_at = ?
     WHERE closed_at IS NULL ${siteId === undefined ? "" : "AND site_id = ?"}
       AND NOT EXISTS (SELECT 1 FROM sites s JOIN businesses b ON b.id = s.business_id WHERE s.id = site_incidents.site_id AND ${monitoredSiteSql("s", "b")})`,
  ).bind(...(siteId === undefined ? [now] : [now, siteId])).run();
  return res.meta.changes ?? 0;
}
