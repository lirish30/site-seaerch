import { domainOf } from "./businesses";

export const DO_NOT_CONTACT_KINDS = ["email", "domain", "name"] as const;
export type DoNotContactKind = (typeof DO_NOT_CONTACT_KINDS)[number];
/** `webfor` is only an enum label so the owner can tag entries himself; nothing is ever seeded. */
export const DO_NOT_CONTACT_REASONS = ["client", "opt_out", "competitor", "active_deal", "bounced", "webfor", "other"] as const;
export type DoNotContactReason = (typeof DO_NOT_CONTACT_REASONS)[number];

export interface DoNotContact { id: string; kind: DoNotContactKind; value: string; reason: DoNotContactReason; note: string | null; created_at: string; }

/** Bad input to `addDoNotContact`. The message is safe to show. */
export class InvalidDoNotContact extends Error {}

const NAME_NOISE = new Set(["llc", "inc", "co", "corp"]);

/** A company name reduced for comparison: lower case, punctuation gone, `llc|inc|co|corp` dropped, spaces collapsed. */
export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((t) => t && !NAME_NOISE.has(t)).join(" ");
}

/** An email address for comparison: trimmed and lower-cased. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

/** A host for comparison: lower case, no scheme/path/`www.`, no trailing dot. Null when it is not a dotted host. */
export function normalizeHost(raw: string | null | undefined): string | null {
  const d = domainOf(raw?.trim() || null)?.replace(/\.+$/, "");
  return d && d.includes(".") ? d : null;
}

/** True when `host` is `listed` or a subdomain of it (`mail.acme.com` of `acme.com`, never `notacme.com`). */
export const hostWithin = (host: string, listed: string): boolean => host === listed || host.endsWith(`.${listed}`);

/** Free-mail providers: a domain entry would block every person on them. A single address is an Email entry instead. */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
]);

/** Normalizes a value for its kind. Throws `InvalidDoNotContact` for anything unusable. */
export function normalizeDoNotContactValue(kind: DoNotContactKind, raw: string): string {
  if (kind === "email") {
    const e = normalizeEmail(raw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new InvalidDoNotContact("enter an email address such as name@company.com");
    return e;
  }
  if (kind === "domain") {
    const d = normalizeHost(raw);
    if (!d) throw new InvalidDoNotContact("enter a domain such as company.com");
    if (FREE_MAIL_DOMAINS.has(d)) throw new InvalidDoNotContact("use an Email entry for a single address instead of blocking a whole free-mail provider");
    return d;
  }
  const n = normalizeName(raw);
  if (!n) throw new InvalidDoNotContact("enter a company name");
  return n.slice(0, 300);
}

export async function listDoNotContact(db: D1Database): Promise<DoNotContact[]> {
  return (await db.prepare(`SELECT * FROM do_not_contact ORDER BY created_at DESC, id`).all<DoNotContact>()).results;
}

/** Throws the D1 UNIQUE error for a value that is already listed (see `isDuplicateKey` in db/services). */
export async function addDoNotContact(
  db: D1Database, i: { kind: DoNotContactKind; value: string; reason: DoNotContactReason; note?: string | null },
): Promise<DoNotContact> {
  if (!DO_NOT_CONTACT_KINDS.includes(i.kind)) throw new InvalidDoNotContact(`kind must be one of ${DO_NOT_CONTACT_KINDS.join(", ")}`);
  if (!DO_NOT_CONTACT_REASONS.includes(i.reason)) throw new InvalidDoNotContact(`reason must be one of ${DO_NOT_CONTACT_REASONS.join(", ")}`);
  const value = normalizeDoNotContactValue(i.kind, i.value);
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO do_not_contact (id, kind, value, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, i.kind, value, i.reason, i.note?.trim() || null, new Date().toISOString()).run();
  return (await db.prepare(`SELECT * FROM do_not_contact WHERE id = ?`).bind(id).first<DoNotContact>())!;
}

/** True if a row was deleted. */
export async function removeDoNotContact(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM do_not_contact WHERE id = ?`).bind(id).run()).meta.changes ?? 0) > 0;
}
