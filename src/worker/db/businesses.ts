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
    WHERE sr.search_id = ? ${o.hideSkipped ? "AND b.lead_status != 'skip'" : ""}`;
  return (await db.prepare(sql).bind(searchId).all<Business>()).results;
}

export async function listAllBusinesses(db: D1Database, o: { status?: LeadStatus; limit?: number; offset?: number }) {
  const page = `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const lim = o.limit ?? -1, off = o.offset ?? 0;
  const stmt = o.status
    ? db.prepare(`SELECT * FROM businesses WHERE lead_status = ? ${page}`).bind(o.status, lim, off)
    : db.prepare(`SELECT * FROM businesses ${page}`).bind(lim, off);
  return (await stmt.all<Business>()).results;
}

export async function updateLead(db: D1Database, id: string, u: { leadStatus?: LeadStatus; notes?: string }) {
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
