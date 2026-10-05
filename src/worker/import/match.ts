import type { Business } from "../types";
import { businessDomain, siteDomain } from "../db/businesses";
import { namesSimilar } from "./names";

export interface ImportRow { name: string; url: string | null; address?: string | null; phone?: string | null; category?: string | null; source: string }
export type MatchKind = "new" | "exact" | "ambiguous";

/**
 * How an import row relates to existing businesses. Pure: `existing` is whatever the caller loaded (the whole table is fine).
 * - exact: one business shares the row's domain and has a similar name.
 * - ambiguous: same domain but a different name, same name on a different (or no) domain, or more than one business matches.
 * - new: nothing matches. A row with no usable domain is never exact, so a name match alone always asks the user.
 * A social/listing host (facebook.com, yelp.com, ...) is not a domain: it can match by name only.
 */
export function matchBusiness(row: ImportRow, existing: Business[]): { kind: MatchKind; candidates: Business[] } {
  const domain = siteDomain(row.url);
  const hits = existing.filter((b) => (domain !== null && businessDomain(b) === domain) || namesSimilar(row.name, b.name));
  if (hits.length === 0) return { kind: "new", candidates: [] };
  const only = hits[0];
  if (hits.length === 1 && domain !== null && businessDomain(only) === domain && namesSimilar(row.name, only.name)) return { kind: "exact", candidates: hits };
  return { kind: "ambiguous", candidates: hits };
}
