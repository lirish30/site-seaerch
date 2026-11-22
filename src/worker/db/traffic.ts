// Traffic data (Plan 16): the Google properties linked to a site and the monthly facts pulled from them.
// Times are UTC ISO strings with milliseconds. A month's `facts` are a JSON snapshot (typed by the puller; read back as parsed JSON, or null when unreadable).

export interface SiteLink {
  siteId: string; gscProperty: string | null; ga4Property: string | null; gbpLocation: string | null; linkedAt: string; checkedAt: string | null;
  /** Plain words for why the last read failed; empty when it worked. */
  lastError: string;
}

export type TrafficStatus = "ok" | "partial" | "failed";

export interface TrafficMonth { siteId: string; period: string; status: TrafficStatus; facts: unknown; pulledAt: string; attempts: number; error: string }

interface LinkRow { site_id: string; gsc_property: string | null; ga4_property: string | null; gbp_location: string | null; linked_at: string; checked_at: string | null; last_error: string }
interface MonthRow { site_id: string; period: string; status: TrafficStatus; facts: string; pulled_at: string; attempts: number; error: string }

const toLink = (r: LinkRow): SiteLink => ({
  siteId: r.site_id, gscProperty: r.gsc_property, ga4Property: r.ga4_property, gbpLocation: r.gbp_location, linkedAt: r.linked_at, checkedAt: r.checked_at, lastError: r.last_error,
});

const toMonth = (r: MonthRow): TrafficMonth => {
  let facts: unknown = null;
  try { facts = JSON.parse(r.facts); } catch { /* an unreadable snapshot is null */ }
  return { siteId: r.site_id, period: r.period, status: r.status, facts, pulledAt: r.pulled_at, attempts: r.attempts, error: r.error };
};

export async function getLink(db: D1Database, siteId: string): Promise<SiteLink | null> {
  const r = await db.prepare(`SELECT * FROM site_analytics WHERE site_id = ?`).bind(siteId).first<LinkRow>();
  return r ? toLink(r) : null;
}

/** Links a site, or changes the links it has; only the keys given are touched (`null` unlinks one source). `linkedAt` is when the site was first linked. */
export async function saveLink(
  db: D1Database, siteId: string, p: { gscProperty?: string | null; ga4Property?: string | null; gbpLocation?: string | null }, now: string,
): Promise<SiteLink> {
  const has = (v: unknown) => (v !== undefined ? 1 : 0);
  await db.prepare(
    `INSERT INTO site_analytics (site_id, gsc_property, ga4_property, gbp_location, linked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET
       gsc_property = CASE WHEN ? = 1 THEN excluded.gsc_property ELSE gsc_property END,
       ga4_property = CASE WHEN ? = 1 THEN excluded.ga4_property ELSE ga4_property END,
       gbp_location = CASE WHEN ? = 1 THEN excluded.gbp_location ELSE gbp_location END`,
  ).bind(siteId, p.gscProperty ?? null, p.ga4Property ?? null, p.gbpLocation ?? null, now, has(p.gscProperty), has(p.ga4Property), has(p.gbpLocation)).run();
  const link = await getLink(db, siteId);
  if (!link) throw new Error("could not save the link");
  return link;
}

export async function deleteLink(db: D1Database, siteId: string): Promise<void> {
  await db.prepare(`DELETE FROM site_analytics WHERE site_id = ?`).bind(siteId).run();
}

/** Notes how the last read went: an error, or `""` for a clean read (which clears the old one). Either way `checked_at` is stamped. */
export async function setLinkError(db: D1Database, siteId: string, error: string, now: string): Promise<void> {
  await db.prepare(`UPDATE site_analytics SET last_error = ?, checked_at = ? WHERE site_id = ?`).bind(error, now, siteId).run();
}

/** The links of a client's sites that are not archived, oldest site first, with each site's domain. */
export async function linksForBusiness(db: D1Database, businessId: string): Promise<(SiteLink & { domain: string | null })[]> {
  const rows = (await db.prepare(
    `SELECT a.*, s.domain AS domain FROM site_analytics a JOIN sites s ON s.id = a.site_id WHERE s.business_id = ? AND s.archived_at IS NULL ORDER BY s.created_at, s.rowid`,
  ).bind(businessId).all<LinkRow & { domain: string | null }>()).results;
  return rows.map((r) => ({ ...toLink(r), domain: r.domain }));
}

export async function getTrafficMonth(db: D1Database, siteId: string, period: string): Promise<TrafficMonth | null> {
  const r = await db.prepare(`SELECT * FROM traffic_months WHERE site_id = ? AND period = ?`).bind(siteId, period).first<MonthRow>();
  return r ? toMonth(r) : null;
}

/**
 * Saves a month's pull. A second pull of the same month replaces the row and counts one more attempt, except that a complete (`ok`) row is only ever replaced by another `ok` one (even a manual,
 * forced pull cannot swap good facts for a worse result): a later failed or partial pull never throws away good facts. One statement, so racing pulls cannot undo each other.
 */
export async function saveTrafficMonth(
  db: D1Database, m: { siteId: string; period: string; status: TrafficStatus; facts: unknown; error?: string }, now: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO traffic_months (site_id, period, status, facts, pulled_at, attempts, error) VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (site_id, period) DO UPDATE SET status = excluded.status, facts = excluded.facts, pulled_at = excluded.pulled_at, attempts = traffic_months.attempts + 1, error = excluded.error
     WHERE traffic_months.status <> 'ok' OR excluded.status = 'ok'`,
  ).bind(m.siteId, m.period, m.status, JSON.stringify(m.facts ?? null), now, m.error ?? "").run();
}

/** The month's pulls of a client's linked sites that are not archived, oldest site first. A site with no row for the month is not in the list. */
export async function monthsFor(db: D1Database, businessId: string, period: string): Promise<TrafficMonth[]> {
  const rows = (await db.prepare(
    `SELECT t.* FROM traffic_months t JOIN site_analytics a ON a.site_id = t.site_id JOIN sites s ON s.id = t.site_id
     WHERE s.business_id = ? AND s.archived_at IS NULL AND t.period = ? ORDER BY s.created_at, s.rowid`,
  ).bind(businessId, period).all<MonthRow>()).results;
  return rows.map(toMonth);
}
