export const PACKAGE_KEYS = [
  "quick_fix", "starter_site", "growth_site", "website_subscription", "care", "care_plus", "care_fallback",
  "client_hosted_surcharge", "local_seo", "local_seo_growth", "reviews_addon", "hourly",
] as const;
export type PackageKey = (typeof PACKAGE_KEYS)[number];
export type PackageKind = "one_time" | "monthly" | "subscription" | "hourly";

export interface Package {
  id: string; key: PackageKey; version: number; name: string; kind: PackageKind;
  priceCents: number;
  /** The one-time part of a recurring package (Subscription $497, Local SEO $750). */
  setupCents: number;
  termMonths: number | null;
  /** The hourly rate for Care clients ($95). */
  altPriceCents: number | null;
  fromPrice: boolean; summary: string; includes: string[];
  wordpressOnly: boolean;
  /** False for the Care fallback: never shown in an option. */
  publicOffer: boolean;
  active: boolean; createdAt: string;
}
/** What a deal or proposal keeps of a package, so a later price change never alters it. */
export type PackageSnapshot = Pick<Package, "key" | "version" | "name" | "kind" | "priceCents" | "setupCents" | "termMonths" | "fromPrice">;
export type PackagePatch = Partial<Pick<Package, "name" | "priceCents" | "setupCents" | "termMonths" | "altPriceCents" | "summary" | "includes" | "active">>;

export class PackageInputError extends Error {}

interface Row {
  id: string; key: PackageKey; version: number; name: string; kind: PackageKind; price_cents: number; setup_cents: number;
  term_months: number | null; alt_price_cents: number | null; from_price: number; summary: string; includes: string;
  wordpress_only: number; public_offer: number; active: number; created_at: string;
}

const includesOf = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
const toPackage = (r: Row): Package => ({
  id: r.id, key: r.key, version: r.version, name: r.name, kind: r.kind, priceCents: r.price_cents, setupCents: r.setup_cents,
  termMonths: r.term_months, altPriceCents: r.alt_price_cents, fromPrice: !!r.from_price, summary: r.summary, includes: includesOf(r.includes),
  wordpressOnly: !!r.wordpress_only, publicOffer: !!r.public_offer, active: !!r.active, createdAt: r.created_at,
});

export const snapshotOf = (p: Package): PackageSnapshot => ({
  key: p.key, version: p.version, name: p.name, kind: p.kind, priceCents: p.priceCents, setupCents: p.setupCents, termMonths: p.termMonths, fromPrice: p.fromPrice,
});

/** The highest version of every package, in catalog order. */
export async function listCurrentPackages(db: D1Database): Promise<Package[]> {
  const rows = (await db.prepare(
    `SELECT p.* FROM packages p WHERE p.version = (SELECT MAX(version) FROM packages WHERE key = p.key)`,
  ).all<Row>()).results.map(toPackage);
  return rows.sort((a, b) => PACKAGE_KEYS.indexOf(a.key) - PACKAGE_KEYS.indexOf(b.key));
}

/** One version of a package; the current one when `version` is left out. */
export async function getPackage(db: D1Database, key: PackageKey, version?: number): Promise<Package | null> {
  const r = version === undefined
    ? await db.prepare(`SELECT * FROM packages WHERE key = ? ORDER BY version DESC LIMIT 1`).bind(key).first<Row>()
    : await db.prepare(`SELECT * FROM packages WHERE key = ? AND version = ?`).bind(key, version).first<Row>();
  return r ? toPackage(r) : null;
}

const wholeCents = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Saves a change as the next version. Never updates a row. Throws PackageInputError for bad cents or an unknown key. */
export async function savePackage(db: D1Database, key: PackageKey, patch: PackagePatch): Promise<Package> {
  const cur = await getPackage(db, key);
  if (!cur) throw new PackageInputError(`unknown package ${key}`);
  if (patch.priceCents !== undefined && !wholeCents(patch.priceCents)) throw new PackageInputError("price must be a whole number of cents, zero or more");
  if (patch.setupCents !== undefined && !wholeCents(patch.setupCents)) throw new PackageInputError("setup fee must be a whole number of cents, zero or more");
  if (patch.altPriceCents !== undefined && patch.altPriceCents !== null && !wholeCents(patch.altPriceCents)) throw new PackageInputError("alternate price must be a whole number of cents, zero or more");
  if (patch.termMonths !== undefined && patch.termMonths !== null && !(Number.isInteger(patch.termMonths) && patch.termMonths > 0)) throw new PackageInputError("term must be a whole number of months");
  if (patch.name !== undefined && !patch.name.trim()) throw new PackageInputError("name cannot be empty");
  const next: Package = {
    ...cur, ...patch, name: (patch.name ?? cur.name).trim(), version: cur.version + 1, id: `pkg_${key}_${cur.version + 1}`, createdAt: new Date().toISOString(),
  };
  await db.batch([db.prepare(
    `INSERT INTO packages (id, key, version, name, kind, price_cents, setup_cents, term_months, alt_price_cents, from_price, summary, includes, wordpress_only, public_offer, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(next.id, key, next.version, next.name, next.kind, next.priceCents, next.setupCents, next.termMonths, next.altPriceCents, next.fromPrice ? 1 : 0,
    next.summary, JSON.stringify(next.includes), next.wordpressOnly ? 1 : 0, next.publicOffer ? 1 : 0, next.active ? 1 : 0, next.createdAt)]);
  return next;
}
