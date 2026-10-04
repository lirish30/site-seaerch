import { catalogFits } from "./catalog";
import { CRO_LIMITS } from "./config";
import type { BizModelKey, CroPageKind, Evidence, RankedItem, RecArea, Recommendation } from "./types";

const IMPACT = { high: 3, medium: 2, low: 1 } as const;
const EFFORT = { low: 0, medium: 1, high: 2 } as const;
const HIGH_INTENT: CroPageKind[] = ["home", "contact", "booking", "services", "pricing", "shop", "menu"];
const FRICTION: RecArea[] = ["forms", "booking", "header_nav", "mobile"];
const FOLD = { desktop: 900, mobile: 844 } as const;

/** PXL-style priority: one point per yes, from facts rather than the model's opinion. */
export function pxlScore(r: Recommendation, byId: Map<string, Evidence>, model: BizModelKey): number {
  const cited = r.evidence_ids.map((id) => byId.get(id)).filter((e): e is Evidence => !!e);
  return [
    cited.some((e) => (e.crop && e.crop.y < FOLD[e.crop.device]) || /before scrolling|header/i.test(e.fact)),
    cited.some((e) => HIGH_INTENT.includes(e.pageKind)),
    FRICTION.includes(r.area),
    cited.length >= 2,
    r.effort === "low",
    !!r.catalog_id && catalogFits(r.catalog_id, model),
  ].filter(Boolean).length;
}

export function rankRecommendations(recs: Recommendation[], evidence: Evidence[], model: BizModelKey, o: { trackingGap: boolean }): RankedItem[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const scored = recs.map((r, i) => ({ r, i, pxl: pxlScore(r, byId, model) }));
  scored.sort((a, b) => b.pxl * IMPACT[b.r.impact] - a.pxl * IMPACT[a.r.impact] || EFFORT[a.r.effort] - EFFORT[b.r.effort] || a.i - b.i);
  // Nothing else can be proven without measurement, so a missing tracking setup goes first.
  if (o.trackingGap) {
    const t = scored.findIndex((s) => s.r.area === "tracking");
    if (t > 0) scored.unshift(...scored.splice(t, 1));
  }
  return scored.slice(0, CRO_LIMITS.maxItems).map((s, i) => ({
    ...s.r, pxl_score: s.pxl, rank: i + 1,
    horizon: i < CRO_LIMITS.topItems ? 30 : s.r.mode === "strategic" || s.r.effort === "high" ? 90 : 60,
  }));
}
