import { siteDomain } from "./businesses";

export const ACCESS_KEYS = ["hosting", "dns", "registrar", "admin", "gbp", "analytics"] as const;
export type AccessKey = (typeof ACCESS_KEYS)[number];
export const ACCESS_STATUSES = ["needed", "requested", "received", "verified", "not_applicable"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];
export type HostingTier = "logan_hosted" | "client_hosted" | "unknown";
export type AccessMethod = "ssh_wpcli" | "mainwp" | "none" | "unknown";
export type Cms = "wordpress" | "webflow" | "wix" | "squarespace" | "shopify" | "custom" | "unknown";

export interface Site {
  id: string; businessId: string; seedKey: "primary" | null; url: string | null; domain: string | null; cms: Cms; hostProvider: string | null; registrar: string | null;
  dnsProvider: string | null; adminUrl: string | null; hostingTier: HostingTier; accessMethod: AccessMethod; notes: string | null; test: boolean;
  archivedAt: string | null; createdAt: string; updatedAt: string;
  /** Monitoring is switched on by hand (a live Care subscription also turns it on). `domainExpiresOn` is a YYYY-MM-DD date; `domainCheckedAt` is when the registry was last asked. */
  monitoring: boolean; domainExpiresOn: string | null; domainCheckedAt: string | null;
}

/** One line of a site's access checklist. `vaultItem` is the NAME of a password-manager item, never a login. */
export interface AccessItem {
  siteId: string; key: AccessKey; status: AccessStatus; vaultItem: string | null; note: string | null;
  requestedAt: string | null; receivedAt: string | null; verifiedAt: string | null; updatedAt: string;
}

/** The editable fields of a site. `domain` is worked out from `url` when it is not given. */
export interface SiteFields {
  url: string | null; domain: string | null; cms: Cms; hostProvider: string | null; registrar: string | null; dnsProvider: string | null; adminUrl: string | null;
  hostingTier: HostingTier; accessMethod: AccessMethod; notes: string | null;
}

/** Another live site of the same business already has this domain. */
export class SiteConflictError extends Error {
  constructor(message = "this client already has a live site with that domain") { super(message); this.name = "SiteConflictError"; }
}

export interface SiteRow {
  id: string; business_id: string; seed_key: "primary" | null; url: string | null; domain: string | null; cms: Cms; host_provider: string | null; registrar: string | null;
  dns_provider: string | null; admin_url: string | null; hosting_tier: HostingTier; access_method: AccessMethod; notes: string | null; test: number;
  archived_at: string | null; created_at: string; updated_at: string; monitoring: number; domain_expires_on: string | null; domain_checked_at: string | null;
}
interface AccessRow {
  site_id: string; key: AccessKey; status: AccessStatus; vault_item: string | null; note: string | null;
  requested_at: string | null; received_at: string | null; verified_at: string | null; updated_at: string;
}

export const toSite = (r: SiteRow): Site => ({
  id: r.id, businessId: r.business_id, seedKey: r.seed_key, url: r.url, domain: r.domain, cms: r.cms, hostProvider: r.host_provider, registrar: r.registrar,
  dnsProvider: r.dns_provider, adminUrl: r.admin_url, hostingTier: r.hosting_tier, accessMethod: r.access_method, notes: r.notes, test: !!r.test,
  archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
  monitoring: !!r.monitoring, domainExpiresOn: r.domain_expires_on, domainCheckedAt: r.domain_checked_at,
});
const toAccess = (r: AccessRow): AccessItem => ({
  siteId: r.site_id, key: r.key, status: r.status, vaultItem: r.vault_item, note: r.note,
  requestedAt: r.requested_at, receivedAt: r.received_at, verifiedAt: r.verified_at, updatedAt: r.updated_at,
});

const COLUMNS: Record<keyof SiteFields, string> = {
  url: "url", domain: "domain", cms: "cms", hostProvider: "host_provider", registrar: "registrar", dnsProvider: "dns_provider", adminUrl: "admin_url",
  hostingTier: "hosting_tier", accessMethod: "access_method", notes: "notes",
};
const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e)) || /UNIQUE constraint failed/i.test(String((e as { cause?: { message?: string } })?.cause?.message ?? ""));

export async function getSite(db: D1Database, id: string): Promise<Site | null> {
  const r = await db.prepare(`SELECT * FROM sites WHERE id = ?`).bind(id).first<SiteRow>();
  return r ? toSite(r) : null;
}

/**
 * Makes a site with its six `needed` access items in one batch. With a `seedKey` a second call for the same business returns the first site with
 * `created: false` and changes nothing. A hand-added site (no seed key) is always new. A live site with the same domain on the same business throws SiteConflictError.
 */
export async function createSite(
  db: D1Database, o: { businessId: string; seedKey?: "primary"; test?: boolean } & Partial<SiteFields>,
): Promise<{ site: Site; created: boolean }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const url = o.url ?? null;
  const domain = o.domain !== undefined ? siteDomain(o.domain) : siteDomain(url);
  // ON CONFLICT DO NOTHING covers both unique indexes, so the batch never fails on a duplicate; the items only go in when this very site does.
  const results = await db.batch([
    db.prepare(
      `INSERT INTO sites (id, business_id, seed_key, url, domain, cms, host_provider, registrar, dns_provider, admin_url, hosting_tier, access_method, notes, test, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(
      id, o.businessId, o.seedKey ?? null, url, domain, o.cms ?? "unknown", o.hostProvider ?? null, o.registrar ?? null, o.dnsProvider ?? null, o.adminUrl ?? null,
      o.hostingTier ?? "unknown", o.accessMethod ?? "unknown", o.notes ?? null, o.test ? 1 : 0, now, now,
    ),
    // One statement per key: D1 caps a compound SELECT at a handful of terms, so six keys do not fit in one.
    ...ACCESS_KEYS.map((k) => db.prepare(
      `INSERT INTO site_access_items (site_id, key, status, updated_at) SELECT ?1, ?2, 'needed', ?3 WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?1)`,
    ).bind(id, k, now)),
  ]);
  if ((results[0].meta.changes ?? 0) === 1) return { site: (await getSite(db, id))!, created: true };
  if (o.seedKey) {
    const existing = await db.prepare(`SELECT * FROM sites WHERE business_id = ? AND seed_key = ?`).bind(o.businessId, o.seedKey).first<SiteRow>();
    if (existing) return { site: toSite(existing), created: false };
  }
  throw new SiteConflictError();
}

export async function listSites(db: D1Database, o: { businessId?: string; includeArchived?: boolean } = {}): Promise<Site[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (o.businessId !== undefined) { where.push("business_id = ?"); binds.push(o.businessId); }
  if (!o.includeArchived) where.push("archived_at IS NULL");
  const rows = (await db.prepare(`SELECT * FROM sites${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`).bind(...binds).all<SiteRow>()).results;
  return rows.map(toSite);
}

/**
 * Changes the fields given. A new `url` without a `domain` re-derives the domain. Returns null for an unknown site; throws SiteConflictError on a duplicate live domain.
 * Care monitoring follows the address: clearing it closes the site's open incidents, and a changed domain forgets the old domain's expiry (date and lookup time) and closes its
 * `domain_expiring` incident, so the next daily look asks the registry about the new one. Both closes are silent, as in `closeUnmonitoredIncidents`.
 */
export async function updateSite(db: D1Database, id: string, patch: Partial<SiteFields>, now: string): Promise<Site | null> {
  const p: Partial<SiteFields> = { ...patch };
  if (p.domain !== undefined) p.domain = siteDomain(p.domain);
  else if (p.url !== undefined) p.domain = siteDomain(p.url);
  const sets: string[] = [], binds: unknown[] = [];
  for (const k of Object.keys(COLUMNS) as (keyof SiteFields)[]) {
    if (p[k] === undefined) continue;
    sets.push(`${COLUMNS[k]} = ?`); binds.push(p[k]);
  }
  if (sets.length === 0) return getSite(db, id);
  const before = p.url !== undefined || p.domain !== undefined ? await getSite(db, id) : null;
  const domainChanged = !!before && p.domain !== undefined && p.domain !== before.domain;
  if (domainChanged) sets.push("domain_expires_on = NULL", "domain_checked_at = NULL");
  try {
    await db.prepare(`UPDATE sites SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds, now, id).run();
  } catch (e) {
    if (isUnique(e)) throw new SiteConflictError();
    throw e;
  }
  if (before && p.url !== undefined && (p.url === null || p.url.trim() === "")) await closeSiteIncidents(db, id, now);
  else if (domainChanged) await closeSiteIncidents(db, id, now, "domain_expiring");
  return getSite(db, id);
}

/** Closes the site's open incidents (all of them, or one kind) without a word in the activity log. Plain SQL here: db/monitoring.ts imports this file. */
async function closeSiteIncidents(db: D1Database, siteId: string, now: string, kind?: "domain_expiring"): Promise<void> {
  await db.prepare(`UPDATE site_incidents SET closed_at = ? WHERE site_id = ? AND closed_at IS NULL${kind ? " AND kind = ?" : ""}`).bind(...(kind ? [now, siteId, kind] : [now, siteId])).run();
}

/** Archives a live site (its domain is freed) and closes its open incidents. False when it is unknown or already archived. */
export async function archiveSite(db: D1Database, id: string, now: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE sites SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`).bind(now, now, id).run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await closeSiteIncidents(db, id, now);
  return true;
}

/**
 * Makes a hand-added live site the business's `primary` (the seed key), so a later seed finds it instead of making a second one. Only when the site has no seed key,
 * is not archived, and the business has no primary yet, all in one statement. Returns the site, or null when any of that does not hold.
 */
export async function adoptAsPrimary(db: D1Database, id: string, now: string): Promise<Site | null> {
  const res = await db.prepare(
    `UPDATE sites SET seed_key = 'primary', updated_at = ?1
     WHERE id = ?2 AND seed_key IS NULL AND archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sites p WHERE p.business_id = sites.business_id AND p.seed_key = 'primary')`,
  ).bind(now, id).run();
  return (res.meta.changes ?? 0) === 1 ? getSite(db, id) : null;
}

/**
 * What a later seed may change on a site it already made: a test site becomes real when `real` is true (never the other way), and a hosting tier that is still `unknown`
 * takes `hostingTier` (a tier anyone has set is never touched). One guarded statement, so it cannot overwrite an edit made at the same moment. Returns the site as it now is.
 */
export async function refreshSeededSite(db: D1Database, id: string, o: { real: boolean; hostingTier: HostingTier }, now: string): Promise<Site | null> {
  await db.prepare(
    `UPDATE sites SET
       test = CASE WHEN ?1 = 1 THEN 0 ELSE test END,
       hosting_tier = CASE WHEN hosting_tier = 'unknown' THEN ?2 ELSE hosting_tier END,
       updated_at = ?3
     WHERE id = ?4 AND ((?1 = 1 AND test = 1) OR (hosting_tier = 'unknown' AND ?2 <> 'unknown'))`,
  ).bind(o.real ? 1 : 0, o.hostingTier, now, id).run();
  return getSite(db, id);
}

/** True when the business has any site, archived ones included, so a lead is never deleted from under its history. */
export async function hasSite(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM sites WHERE business_id = ? LIMIT 1`).bind(businessId).first());
}

/** The site's six access items, always in ACCESS_KEYS order. */
export async function listAccess(db: D1Database, siteId: string): Promise<AccessItem[]> {
  const rows = (await db.prepare(`SELECT * FROM site_access_items WHERE site_id = ?`).bind(siteId).all<AccessRow>()).results;
  return rows.map(toAccess).sort((a, b) => ACCESS_KEYS.indexOf(a.key) - ACCESS_KEYS.indexOf(b.key));
}

/**
 * Changes one access item. The timestamps follow the new status in the same UPDATE, so two writers cannot disagree:
 * requested stamps requested_at once and it is never cleared; received (or verified) stamps received_at once; verified stamps verified_at once;
 * moving back to an earlier status clears the stamps that no longer hold. `vaultItem` and `note` change only when given (null clears them).
 * Returns null for an unknown site or key.
 */
export async function setAccess(
  db: D1Database, siteId: string, key: AccessKey, patch: { status?: AccessStatus; vaultItem?: string | null; note?: string | null }, now: string,
): Promise<AccessItem | null> {
  if (!ACCESS_KEYS.includes(key)) return null;
  if (patch.status !== undefined && !ACCESS_STATUSES.includes(patch.status)) throw new RangeError(`unknown access status ${String(patch.status)}`);
  // ?1 status (or null to keep), ?2 now, ?3/?4 vault item given + value, ?5/?6 note given + value, ?7 site, ?8 key.
  const res = await db.prepare(
    `UPDATE site_access_items SET
       status = COALESCE(?1, status),
       requested_at = CASE WHEN COALESCE(?1, status) = 'requested' THEN COALESCE(requested_at, ?2) ELSE requested_at END,
       received_at = CASE WHEN COALESCE(?1, status) IN ('received', 'verified') THEN COALESCE(received_at, ?2) ELSE NULL END,
       verified_at = CASE WHEN COALESCE(?1, status) = 'verified' THEN COALESCE(verified_at, ?2) ELSE NULL END,
       vault_item = CASE WHEN ?3 = 1 THEN ?4 ELSE vault_item END,
       note = CASE WHEN ?5 = 1 THEN ?6 ELSE note END,
       updated_at = ?2
     WHERE site_id = ?7 AND key = ?8`,
  ).bind(
    patch.status ?? null, now, patch.vaultItem !== undefined ? 1 : 0, patch.vaultItem ?? null, patch.note !== undefined ? 1 : 0, patch.note ?? null, siteId, key,
  ).run();
  if ((res.meta.changes ?? 0) === 0) return null;
  const r = await db.prepare(`SELECT * FROM site_access_items WHERE site_id = ? AND key = ?`).bind(siteId, key).first<AccessRow>();
  return r ? toAccess(r) : null;
}
