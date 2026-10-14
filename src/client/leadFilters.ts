import type { LeadRow } from "./types";

export const OFFERS = ["new_site", "performance", "care_plan", "seo_basics", "conversion"] as const;
export const NOT_CRAWLED = "not_crawled";
// minReviews / maxRating: null (or <= 0 for minReviews) means off. offer / platform: "any" means off.
export interface LeadFilters { hideSkipped: boolean; minScore: number; emailOnly: boolean; minReviews: number | null; maxRating: number | null; offer: "any" | (typeof OFFERS)[number]; platform: string; }
export const defaultFilters: LeadFilters = { hideSkipped: true, minScore: 0, emailOnly: false, minReviews: null, maxRating: null, offer: "any", platform: "any" };

export const platformOptions = (rows: LeadRow[]) => [...new Set(rows.flatMap((r) => (r.platform ? [r.platform] : [])))].sort();

export const isStarred = (r: LeadRow) => r.business.starred_at !== null;

/** Starred rows first, each group keeping its own order. Returns a new array. */
export const starredFirst = (rows: LeadRow[]): LeadRow[] => [...rows.filter(isStarred), ...rows.filter((r) => !isStarred(r))];

/**
 * A starred lead ignores the quality filters (hide skipped, minimum opportunity, minimum reviews, maximum rating), so tightening
 * them while triaging never hides a lead the user saved. The filters that name what the user is looking for (email, offer, platform)
 * still apply.
 */
export const applyLeadFilters = (rows: LeadRow[], f: LeadFilters): LeadRow[] => {
  const minReviews = f.minReviews ?? 0;
  return rows.filter((r) =>
    (isStarred(r) || ((!f.hideSkipped || r.business.lead_status !== "skip")
      && (r.score ?? 0) >= f.minScore
      && (minReviews <= 0 || (r.reviewCount !== null && r.reviewCount >= minReviews))
      && (f.maxRating === null || (r.rating !== null && r.rating <= f.maxRating))))
    && (!f.emailOnly || r.hasEmail)
    && (f.offer === "any" || r.offer === f.offer)
    && (f.platform === "any" || (f.platform === NOT_CRAWLED ? r.platform === null : r.platform === f.platform)));
};

/** Everything the table filters on that the page can save and restore (sorting and paging are not part of a saved view). */
export interface TableFilters { q: string; niche: string; f: LeadFilters; }
export const defaultTableFilters: TableFilters = { q: "", niche: "", f: defaultFilters };
