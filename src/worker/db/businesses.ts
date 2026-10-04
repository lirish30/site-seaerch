import type { Business, LeadStatus, Listing } from "../types";
import { isSocialOnlyUrl } from "../crawler/extract";

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function getBusiness(db: D1Database, id: string): Promise<Business | null> {
  return db.prepare(`SELECT * FROM businesses WHERE id = ?`).bind(id).first<Business>();
}

export async function upsertBusiness(db: D1Database, l: Listing, searchId: string): Promise<Business> {
  // Social/platform hosts (facebook.com, yelp.com, ...) are shared by unrelated businesses: never store or match them.
  const rawDomain = domainOf(l.websiteUrl);
  const domain = rawDomain && !isSocialOnlyUrl(`https://${rawDomain}/`) ? rawDomain : null;
  let existing: Business | null = null;
  if (l.placeId) existing = await db.prepare(`SELECT * FROM businesses WHERE place_id = ?`).bind(l.placeId).first<Business>();
  // Domain fallback only when one side lacks a place_id; two distinct place_ids are two businesses (e.g. chain branches).
  if (!existing && domain) {
    existing = l.placeId
      ? await db.prepare(`SELECT * FROM businesses WHERE domain = ? AND place_id IS NULL`).bind(domain).first<Business>()
      : await db.prepare(`SELECT * FROM businesses WHERE domain = ?`).bind(domain).first<Business>();
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
  return (await db.prepare(sql).bind(searchId).all<Business>()).results;
}

export async function listAllBusinesses(db: D1Database, o: { status?: LeadStatus; limit?: number; offset?: number; archived?: boolean }) {
  const page = `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const lim = o.limit ?? -1, off = o.offset ?? 0;
  const arch = o.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const stmt = o.status
    ? db.prepare(`SELECT * FROM businesses WHERE lead_status = ? AND ${arch} ${page}`).bind(o.status, lim, off)
    : db.prepare(`SELECT * FROM businesses WHERE ${arch} ${page}`).bind(lim, off);
  return (await stmt.all<Business>()).results;
}

export async function setArchived(db: D1Database, id: string, archived: boolean) {
  await db.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(archived ? new Date().toISOString() : null, id).run();
  return (await getBusiness(db, id))!;
}

/** Permanently removes a lead and everything recorded about it. Raw crawl files in R2 are left to expire. */
export async function deleteBusiness(db: D1Database, id: string) {
  await db.batch([
    db.prepare(`DELETE FROM cro_items WHERE cro_audit_id IN (SELECT id FROM cro_audits WHERE business_id = ?)`).bind(id),
    ...["search_results", "audits", "contacts", "drafts", "people", "activity", "cro_audits"].map((t) =>
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
  if (u.leadStatus) {
    const contactedAt = u.leadStatus === "contacted" ? new Date().toISOString() : null;
    await db.prepare(`UPDATE businesses SET lead_status = ?, contacted_at = COALESCE(?, contacted_at) WHERE id = ?`)
      .bind(u.leadStatus, contactedAt, id).run();
  }
  if (u.notes !== undefined) await db.prepare(`UPDATE businesses SET notes = ? WHERE id = ?`).bind(u.notes, id).run();
  return (await getBusiness(db, id))!;
}

export async function setBusinessError(db: D1Database, id: string, msg: string | null) {
  await db.prepare(`UPDATE businesses SET last_error = ? WHERE id = ?`).bind(msg, id).run();
}
