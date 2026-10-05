import { domainOf } from "./businesses";
import { isSocialOnlyUrl } from "../crawler/extract";
import { SUPPRESSION_REASONS, type Business, type Suppression, type SuppressionKind, type SuppressionReason } from "../types";

/** Bad input to `addSuppression` (empty/invalid value, social-only host, unknown reason). The message is safe to show. */
export class InvalidSuppression extends Error {}

/** A usable domain: normalized, has a dot, and is not a shared social/platform host (those never identify one business). */
function cleanDomain(raw: string | null | undefined): string | null {
  const d = domainOf(raw?.trim() || null);
  return d && d.includes(".") && !isSocialOnlyUrl(`https://${d}/`) ? d : null;
}

/** Normalizes a suppression value for its kind. Throws `InvalidSuppression` for anything unusable. */
export function normalizeSuppressionValue(kind: SuppressionKind, raw: string): string {
  if (kind === "place_id") {
    const v = raw.trim();
    if (!v || v.length > 300) throw new InvalidSuppression("enter a place ID");
    return v;
  }
  if (!raw.trim()) throw new InvalidSuppression("enter a domain such as acme.com");
  const d = domainOf(raw.trim());
  if (d && isSocialOnlyUrl(`https://${d}/`))
    throw new InvalidSuppression(`${d} is a shared social or listing site, and suppressing it would hide unrelated businesses`);
  const clean = cleanDomain(raw);
  if (!clean) throw new InvalidSuppression("enter a domain such as acme.com");
  return clean;
}

export async function listSuppressions(db: D1Database): Promise<Suppression[]> {
  return (await db.prepare(`SELECT * FROM suppressions ORDER BY created_at DESC, id`).all<Suppression>()).results;
}

/** Throws the D1 UNIQUE error for a value that is already listed (see `isDuplicateKey` in db/services). */
export async function addSuppression(
  db: D1Database, i: { kind: SuppressionKind; value: string; reason: SuppressionReason; note?: string | null },
): Promise<Suppression> {
  if (!SUPPRESSION_REASONS.includes(i.reason)) throw new InvalidSuppression(`reason must be one of ${SUPPRESSION_REASONS.join(", ")}`);
  const value = normalizeSuppressionValue(i.kind, i.value);
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO suppressions (id, kind, value, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, i.kind, value, i.reason, i.note?.trim() || null, new Date().toISOString()).run();
  return (await db.prepare(`SELECT * FROM suppressions WHERE id = ?`).bind(id).first<Suppression>())!;
}

/** True if a row was deleted. */
export async function removeSuppression(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM suppressions WHERE id = ?`).bind(id).run()).meta.changes ?? 0) > 0;
}

/** The suppression a business (or search listing) matches by domain or place ID, or null. `domain` and `websiteUrl` are normalized here. */
export async function isSuppressed(
  db: D1Database, b: { domain?: string | null; placeId?: string | null; websiteUrl?: string | null },
): Promise<Suppression | null> {
  const domains = [...new Set([cleanDomain(b.domain), cleanDomain(b.websiteUrl)].filter((d): d is string => !!d))];
  const placeId = b.placeId?.trim() || null;
  if (!domains.length && !placeId) return null;
  const clauses = [placeId ? `(kind = 'place_id' AND value = ?)` : "", ...domains.map(() => `(kind = 'domain' AND value = ?)`)].filter(Boolean);
  return db.prepare(`SELECT * FROM suppressions WHERE ${clauses.join(" OR ")} ORDER BY kind DESC, created_at LIMIT 1`)
    .bind(...(placeId ? [placeId] : []), ...domains).first<Suppression>();
}

/** The suppression a stored lead matches (its own domain, place ID or website host). */
export const leadSuppression = (db: D1Database, b: Pick<Business, "domain" | "place_id" | "website_url">) =>
  isSuppressed(db, { domain: b.domain, placeId: b.place_id, websiteUrl: b.website_url });

/** Suppresses a lead's domain and place ID, skipping rows that already exist. Returns how many rows were added. */
export async function suppressLead(
  db: D1Database, b: Pick<Business, "domain" | "place_id" | "website_url">, i: { reason: SuppressionReason; note?: string | null },
): Promise<number> {
  const targets: { kind: SuppressionKind; value: string }[] = [];
  const domain = cleanDomain(b.domain) ?? cleanDomain(b.website_url);
  if (domain) targets.push({ kind: "domain", value: domain });
  if (b.place_id?.trim()) targets.push({ kind: "place_id", value: b.place_id.trim() });
  if (!targets.length) throw new InvalidSuppression("this lead has no website or place ID to match on");
  let added = 0;
  for (const t of targets) {
    const r = await db.prepare(`INSERT OR IGNORE INTO suppressions (id, kind, value, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), t.kind, t.value, i.reason, i.note?.trim() || null, new Date().toISOString()).run();
    added += r.meta.changes ?? 0;
  }
  return added;
}
