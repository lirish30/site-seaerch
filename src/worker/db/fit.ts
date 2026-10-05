import type { FitProfile } from "../types";

interface Row extends Omit<FitProfile, "industries" | "geos" | "platforms" | "active"> {
  industries: string; geos: string; platforms: string; active: number; created_at: string;
}

const arr = (s: string): any[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const toProfile = (r: Row): FitProfile => ({
  id: r.id, name: r.name, service_key: r.service_key, industries: arr(r.industries), geos: arr(r.geos), platforms: arr(r.platforms),
  min_reviews: r.min_reviews, min_rating: r.min_rating, active: !!r.active,
});

export async function listFitProfiles(db: D1Database, o: { activeOnly?: boolean } = {}): Promise<FitProfile[]> {
  const where = o.activeOnly ? "WHERE active = 1" : "";
  return (await db.prepare(`SELECT * FROM fit_profiles ${where} ORDER BY created_at, rowid`).all<Row>()).results.map(toProfile);
}

export async function getFitProfile(db: D1Database, id: string): Promise<FitProfile | null> {
  const r = await db.prepare(`SELECT * FROM fit_profiles WHERE id = ?`).bind(id).first<Row>();
  return r ? toProfile(r) : null;
}

type Fields = Omit<FitProfile, "id" | "active">;
const JSON_COLS = new Set(["industries", "geos", "platforms"]);
const PATCH_COLS = ["name", "service_key", "industries", "geos", "platforms", "min_reviews", "min_rating", "active"] as const;

export async function createFitProfile(
  db: D1Database, i: Pick<Fields, "name" | "service_key"> & Partial<Fields>,
): Promise<FitProfile> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO fit_profiles (id, name, service_key, industries, geos, platforms, min_reviews, min_rating, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).bind(id, i.name.trim(), i.service_key, JSON.stringify(i.industries ?? []), JSON.stringify(i.geos ?? []), JSON.stringify(i.platforms ?? []),
    i.min_reviews ?? null, i.min_rating ?? null, new Date().toISOString()).run();
  return (await getFitProfile(db, id))!;
}

/** Updates only the fields present in the patch (null clears a threshold). Returns the updated profile, or null for an unknown id. */
export async function updateFitProfile(db: D1Database, id: string, patch: Partial<Fields & { active: boolean }>): Promise<FitProfile | null> {
  const cols = PATCH_COLS.filter((c) => patch[c] !== undefined);
  if (cols.length) {
    const vals = cols.map((c) => JSON_COLS.has(c) ? JSON.stringify(patch[c]) : c === "active" ? (patch[c] ? 1 : 0) : patch[c]);
    await db.prepare(`UPDATE fit_profiles SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...vals, id).run();
  }
  return getFitProfile(db, id);
}

/** True when a profile was removed. */
export async function deleteFitProfile(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM fit_profiles WHERE id = ?`).bind(id).run()).meta.changes ?? 0) > 0;
}
