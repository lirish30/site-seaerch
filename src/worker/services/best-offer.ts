import type { Finding, Offer, Service, Severity } from "../types";
import { offerService } from "../db/services";

export interface BestOffer { service: Service; because: Finding[]; legacyOffer: Offer | null }

const WEIGHT: Record<Severity, number> = { critical: 3, important: 2, nice: 1 };
const SPECIALTY_BOOST = 1.25;
const MAX_BECAUSE = 5;

/** A code matches exactly or, with a trailing `*`, by prefix (`cro:*`); a category match is the fallback for codes no service lists. */
export function serviceMatchesFinding(s: Service, f: Finding): boolean {
  const code = f.code as string;
  if (s.finding_codes.some((p) => (p.endsWith("*") ? code.startsWith(p.slice(0, -1)) : p === code))) return true;
  return s.finding_categories.includes(f.category as Service["finding_categories"][number]);
}

// An unrated (legacy) finding is not low confidence, so it keeps full weight.
const weightOf = (f: Finding) => WEIGHT[f.severity] * (f.confidence === "low" ? 0.5 : 1);

/** The catalog service the findings argue for most, with the findings that support it. */
export function bestOffer(findings: Finding[], services: Service[], legacyOffer: Offer | null = null): BestOffer | null {
  let best: { service: Service; weight: number; matched: Finding[] } | null = null;
  for (const s of services) {
    if (!s.active) continue;
    const matched = findings.filter((f) => serviceMatchesFinding(s, f));
    if (!matched.length) continue;
    const weight = matched.reduce((n, f) => n + weightOf(f), 0) * (s.is_specialty ? SPECIALTY_BOOST : 1);
    if (!best || weight > best.weight || (weight === best.weight && s.sort < best.service.sort)) best = { service: s, weight, matched };
  }
  if (best) {
    const because = best.matched.map((f, i) => ({ f, i }))
      .sort((a, b) => WEIGHT[b.f.severity] - WEIGHT[a.f.severity] || b.f.points - a.f.points || a.i - b.i)
      .slice(0, MAX_BECAUSE).map(({ f }) => f);
    return { service: best.service, because, legacyOffer };
  }
  const fallback = legacyOffer ? offerService(legacyOffer, services) : null;
  return fallback ? { service: fallback, because: [], legacyOffer } : null;
}
