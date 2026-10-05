import type { Offer, Service } from "../types";

interface Row extends Omit<Service, "deliverables" | "prerequisites" | "finding_codes" | "finding_categories" | "is_specialty" | "active"> {
  deliverables: string; prerequisites: string; finding_codes: string; finding_categories: string; is_specialty: number; active: number;
}

const arr = (s: string): any[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const toService = (r: Row): Service => ({
  ...r, deliverables: arr(r.deliverables), prerequisites: arr(r.prerequisites),
  finding_codes: arr(r.finding_codes), finding_categories: arr(r.finding_categories),
  is_specialty: !!r.is_specialty, active: !!r.active,
});

/** "PPC & Paid Media" -> "ppc-paid-media". Empty when the name has no letters or digits. */
export const serviceKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const isDuplicateKey = (e: unknown) => /UNIQUE/i.test(String((e as Error)?.message ?? e));

export async function listServices(db: D1Database, o: { activeOnly?: boolean } = {}): Promise<Service[]> {
  const where = o.activeOnly ? "WHERE active = 1" : "";
  return (await db.prepare(`SELECT * FROM services ${where} ORDER BY sort, key`).all<Row>()).results.map(toService);
}

export async function getService(db: D1Database, id: string): Promise<Service | null> {
  const r = await db.prepare(`SELECT * FROM services WHERE id = ?`).bind(id).first<Row>();
  return r ? toService(r) : null;
}

export async function getServiceByKey(db: D1Database, key: string): Promise<Service | null> {
  const r = await db.prepare(`SELECT * FROM services WHERE key = ?`).bind(key).first<Row>();
  return r ? toService(r) : null;
}

type Patch = Partial<Pick<Service, "name" | "summary" | "deliverables" | "prerequisites" | "first_engagement" | "finding_codes" | "finding_categories" | "is_specialty" | "active">>;
const JSON_COLS = new Set(["deliverables", "prerequisites", "finding_codes", "finding_categories"]);
const BOOL_COLS = new Set(["is_specialty", "active"]);
const PATCH_COLS = ["name", "summary", "deliverables", "prerequisites", "first_engagement", "finding_codes", "finding_categories", "is_specialty", "active"] as const;

/** Updates only the fields present in the patch (the key never changes). Returns the updated service, or null for an unknown id. */
export async function updateService(db: D1Database, id: string, patch: Patch): Promise<Service | null> {
  const cols = PATCH_COLS.filter((c) => patch[c] !== undefined);
  if (cols.length) {
    const vals = cols.map((c) => JSON_COLS.has(c) ? JSON.stringify(patch[c]) : BOOL_COLS.has(c) ? (patch[c] ? 1 : 0) : patch[c]);
    await db.prepare(`UPDATE services SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...vals, id).run();
  }
  return getService(db, id);
}

/** New services go to the end. Throws the D1 UNIQUE error for a duplicate key (see `isDuplicateKey`). */
export async function createService(
  db: D1Database,
  i: { name: string; category: string; summary?: string; deliverables?: string[]; prerequisites?: string[]; first_engagement?: string | null;
    finding_codes?: string[]; finding_categories?: Service["finding_categories"]; is_specialty?: boolean },
): Promise<Service> {
  const key = serviceKey(i.name);
  if (!key) throw new Error("name must contain letters or numbers");
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO services (id, key, name, category, summary, deliverables, prerequisites, first_engagement, finding_codes, finding_categories, is_specialty, active, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort), 0) + 10 FROM services))`,
  ).bind(id, key, i.name.trim(), i.category.trim(), i.summary ?? "", JSON.stringify(i.deliverables ?? []), JSON.stringify(i.prerequisites ?? []),
    i.first_engagement ?? null, JSON.stringify(i.finding_codes ?? []), JSON.stringify(i.finding_categories ?? []), i.is_specialty ? 1 : 0).run();
  return (await getService(db, id))!;
}

/** The legacy per-lead Offer, mapped onto the catalog. */
export const OFFER_TO_SERVICE: Record<Offer, string> = {
  new_site: "web-design-development", performance: "hosting-maintenance", care_plan: "hosting-maintenance",
  seo_basics: "seo", conversion: "conversion-rate-optimization",
};

/** The catalog service an Offer points at, or null if the user removed or deactivated it. */
export function offerService(offer: Offer, services: Service[]): Service | null {
  const s = services.find((x) => x.key === OFFER_TO_SERVICE[offer]);
  return s && s.active ? s : null;
}
