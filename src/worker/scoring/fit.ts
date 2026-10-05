import type { Audit, Business, FitProfile, FitResult } from "../types";

const has = (hay: string | null, needles: string[]) => {
  const h = (hay ?? "").toLowerCase();
  return needles.some((n) => n.trim() && h.includes(n.trim().toLowerCase()));
};

/** [criterion, matched] for each criterion the profile defines. */
function criteria(b: Business, a: Audit | null, p: FitProfile): [string, boolean][] {
  const out: [string, boolean][] = [];
  if (p.industries.length) out.push(["industry", has(b.category, p.industries)]);
  if (p.geos.length) out.push(["geo", has(b.address, p.geos)]);
  if (p.platforms.length) out.push(["platform", !!a?.platform && p.platforms.includes(a.platform)]);
  if (p.min_reviews !== null) out.push(["reviews", b.review_count !== null && b.review_count >= p.min_reviews]);
  if (p.min_rating !== null) out.push(["rating", b.rating !== null && b.rating >= p.min_rating]);
  return out;
}

/**
 * How well a business matches the best of the user's fit profiles. Inputs are business facts and the detected platform only:
 * site health is deliberately never read, so a crawler failure cannot make a good prospect look bad.
 */
export function scoreFit(business: Business, audit: Audit | null, profiles: FitProfile[]): FitResult {
  let best: FitResult | null = null;
  for (const p of profiles) {
    if (!p.active) continue;
    const cs = criteria(business, audit, p);
    if (!cs.length) continue;
    const matched = cs.filter(([, ok]) => ok).map(([k]) => k);
    const fit = Math.round((100 * matched.length) / cs.length);
    if (!best || fit > best.fit!) {
      best = { fit, profile: { id: p.id, name: p.name, service_key: p.service_key }, matched, missing: cs.filter(([, ok]) => !ok).map(([k]) => k) };
    }
  }
  return best ?? { fit: null, profile: null, matched: [], missing: [] };
}
