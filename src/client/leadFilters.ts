import type { LeadRow } from "./types";

export const OFFERS = ["new_site", "performance", "care_plan", "seo_basics"] as const;
export const NOT_CRAWLED = "not_crawled";
// minReviews / maxRating: null (or 0 for minReviews) means off. offer / platform: "any" means off.
export interface LeadFilters { hideSkipped: boolean; minScore: number; emailOnly: boolean; minReviews: number | null; maxRating: number | null; offer: string; platform: string; }
export const defaultFilters: LeadFilters = { hideSkipped: true, minScore: 0, emailOnly: false, minReviews: null, maxRating: null, offer: "any", platform: "any" };

export const platformOptions = (rows: LeadRow[]) => [...new Set(rows.flatMap((r) => (r.platform ? [r.platform] : [])))].sort();

export const applyLeadFilters = (rows: LeadRow[], f: LeadFilters): LeadRow[] => rows.filter((r) =>
  (!f.hideSkipped || r.business.lead_status !== "skip")
  && (r.score ?? 0) >= f.minScore
  && (!f.emailOnly || r.hasEmail)
  && (!f.minReviews || (r.reviewCount !== null && r.reviewCount >= f.minReviews))
  && (f.maxRating === null || (r.rating !== null && r.rating <= f.maxRating))
  && (f.offer === "any" || r.offer === f.offer)
  && (f.platform === "any" || (f.platform === NOT_CRAWLED ? r.platform === null : r.platform === f.platform)));
