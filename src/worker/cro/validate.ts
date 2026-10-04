import { CRO_LIMITS } from "./config";
import type { BusinessModel, Evidence, PageReview, RecArea, Recommendation } from "./types";

export interface Drop { title: string; reason: string }

// The zod schemas carry no .max(), so the code enforces the caps.
const MAX_ISSUES_PER_PAGE = 10;
const MAX_STRENGTHS = 6;

export const normalize = (s: string) => s.normalize("NFKC")
  .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim().toLowerCase();

export function quoteFound(quote: string, texts: string[]): boolean {
  const q = normalize(quote).replace(/^["']+|["']+$/g, "").trim();
  return q.length > 0 && texts.some((t) => normalize(t).includes(q));
}

export const quotedPhrases = (s: string) => [...s.matchAll(/["“]([^"”]{4,})["”]/g)].map((m) => m[1]);

function evidenceProblem(evidenceIds: string[], ids: Set<string>): string | null {
  if (!evidenceIds.length) return "no evidence cited";
  const bad = evidenceIds.filter((id) => !ids.has(id));
  return bad.length ? `cites unknown evidence ${bad.join(", ")}` : null;
}

export function validateReview(r: PageReview, ids: Set<string>, texts: string[]): { review: PageReview; dropped: Drop[] } {
  const dropped: Drop[] = [];
  const issues = r.issues.filter((x) => {
    const reason = evidenceProblem(x.evidence_ids, ids) ?? (x.quote && !quoteFound(x.quote, texts) ? `quote "${x.quote}" is not on the page` : null);
    if (reason) dropped.push({ title: x.observation.slice(0, 80), reason });
    return !reason;
  }).map((x) => ({ ...x, crop_evidence_id: x.crop_evidence_id && ids.has(x.crop_evidence_id) ? x.crop_evidence_id : null }));
  return { review: { ...r, strengths: r.strengths.slice(0, MAX_STRENGTHS), issues: issues.slice(0, MAX_ISSUES_PER_PAGE) }, dropped };
}

export function validateRecommendations(recs: Recommendation[], ids: Set<string>, texts: string[]): { kept: Recommendation[]; dropped: Drop[] } {
  const dropped: Drop[] = [];
  const kept = recs.filter((r) => {
    const badQuote = quotedPhrases(r.observation).find((q) => !quoteFound(q, texts));
    const reason = evidenceProblem(r.evidence_ids, ids) ?? (badQuote ? `quote "${badQuote}" is not on the page` : null);
    if (reason) dropped.push({ title: r.title, reason });
    return !reason;
  });
  return { kept, dropped };
}

export const needsRetry = (total: number, dropped: number) => total > 0 && dropped / total > CRO_LIMITS.retryDropShare;

const BIG_SWINGS: RecArea[] = ["hero", "pricing_offer", "forms"];
/** Small sites can't reach a test result, so only bold changes stay as tests on low traffic. */
export function applyModeRules(recs: Recommendation[], tier: BusinessModel["traffic_tier"]): Recommendation[] {
  return recs.map((r) => (tier === "low" && r.mode === "test" && !BIG_SWINGS.includes(r.area) ? { ...r, mode: "fix_measure" } : r));
}

export function hasTrackingGap(evidence: Evidence[]): boolean {
  return evidence.some((e) => e.family === "martech" && e.data?.analytics === false && e.data?.callTracking === false);
}
