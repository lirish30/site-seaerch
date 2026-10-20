import { followUpTone } from "./leadView";
import type { AuditCategory, LeadRow } from "./types";

export const OFFERS = ["new_site", "performance", "care_plan", "seo_basics", "conversion"] as const;
export const NOT_CRAWLED = "not_crawled";
export const WEBSITE_OPTIONS = ["any", "yes", "no"] as const;
export const OUTREACH_OPTIONS = ["any", "never", "followup", "stale"] as const;
export const SCAN_OPTIONS = ["any", "quick", "full"] as const;
export const CATEGORY_OPTIONS = ["design", "content", "cro", "mobile", "speed", "technical"] as const;
/** A contacted lead with no reply after this many days counts as "stale". */
export const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

// minReviews / maxRating / maxHealth / minFit / addedDays: null (or <= 0 for minReviews) means off. Every "any" value means off.
export interface LeadFilters {
  hideSkipped: boolean; minScore: number; emailOnly: boolean; minReviews: number | null; maxRating: number | null;
  offer: "any" | (typeof OFFERS)[number]; platform: string;
  website: (typeof WEBSITE_OPTIONS)[number]; hasPhone: boolean; hasContact: boolean;
  outreach: (typeof OUTREACH_OPTIONS)[number];
  maxHealth: number | null; category: "any" | AuditCategory; criticalOnly: boolean; minFit: number | null;
  addedDays: number | null; scan: (typeof SCAN_OPTIONS)[number];
}
export const defaultFilters: LeadFilters = {
  hideSkipped: true, minScore: 0, emailOnly: false, minReviews: null, maxRating: null, offer: "any", platform: "any",
  website: "any", hasPhone: false, hasContact: false, outreach: "any", maxHealth: null, category: "any", criticalOnly: false, minFit: null,
  addedDays: null, scan: "any",
};

export const platformOptions = (rows: LeadRow[]) => [...new Set(rows.flatMap((r) => (r.platform ? [r.platform] : [])))].sort();

export const isStarred = (r: LeadRow) => r.business.starred_at !== null;

/** Starred rows first, each group keeping its own order. Returns a new array. */
export const starredFirst = (rows: LeadRow[]): LeadRow[] => [...rows.filter(isStarred), ...rows.filter((r) => !isStarred(r))];

/** How many of the "look for" filters are on (everything except the always-on quality defaults); used for the empty-table hint and the More filters badge. */
export const activeExtraFilters = (f: LeadFilters): number => [
  f.emailOnly, f.minScore > 0, (f.minReviews ?? 0) > 0, f.maxRating !== null, f.hasPhone, f.hasContact, f.outreach !== "any",
  f.maxHealth !== null, f.category !== "any", f.criticalOnly, f.minFit !== null, f.addedDays !== null, f.scan !== "any",
].filter(Boolean).length;

const hasWebsite = (r: LeadRow) => !!r.business.website_url?.trim();

/** Outreach state from the lead's own dates; `now` is injectable for tests. */
function outreachMatches(r: LeadRow, mode: LeadFilters["outreach"], now: Date): boolean {
  const b = r.business;
  switch (mode) {
    case "any": return true;
    case "never": return b.contacted_at === null;
    case "followup": { const t = followUpTone(b.follow_up_at, now); return t === "overdue" || t === "today"; }
    case "stale": {
      const at = b.contacted_at ? Date.parse(b.contacted_at) : NaN;
      return b.lead_status === "contacted" && Number.isFinite(at) && now.getTime() - at >= STALE_DAYS * DAY_MS;
    }
  }
}

/**
 * A starred lead ignores the quality filters (hide skipped, minimum opportunity, minimum reviews, maximum rating, maximum site health,
 * minimum fit), so tightening them while triaging never hides a lead the user saved. The filters that name what the user is looking
 * for (website, email, phone, contact, outreach, top issue, offer, platform, added, scan depth) still apply.
 */
export const applyLeadFilters = (rows: LeadRow[], f: LeadFilters, now = new Date()): LeadRow[] => {
  const minReviews = f.minReviews ?? 0;
  const addedSince = f.addedDays !== null && f.addedDays > 0 ? now.getTime() - f.addedDays * DAY_MS : null;
  return rows.filter((r) =>
    (isStarred(r) || ((!f.hideSkipped || r.business.lead_status !== "skip")
      && (r.score ?? 0) >= f.minScore
      && (minReviews <= 0 || (r.reviewCount !== null && r.reviewCount >= minReviews))
      && (f.maxRating === null || (r.rating !== null && r.rating <= f.maxRating))
      && (f.maxHealth === null || (r.health !== null && r.health <= f.maxHealth))
      && (f.minFit === null || (r.fit.fit !== null && r.fit.fit >= f.minFit))))
    && (f.website === "any" || hasWebsite(r) === (f.website === "yes"))
    && (!f.emailOnly || r.hasEmail)
    && (!f.hasPhone || !!r.business.phone?.trim())
    && (!f.hasContact || r.poc !== null)
    && outreachMatches(r, f.outreach, now)
    && (f.category === "any" || r.topCategory === f.category)
    && (!f.criticalOnly || r.topSeverity === "critical")
    && (addedSince === null || Date.parse(r.business.created_at) >= addedSince)
    && (f.scan === "any" || r.scan_stage === f.scan)
    && (f.offer === "any" || r.offer === f.offer)
    && (f.platform === "any" || (f.platform === NOT_CRAWLED ? r.platform === null : r.platform === f.platform)));
};

/** Everything the table filters on that the page can save and restore (sorting and paging are not part of a saved view). */
export interface TableFilters { q: string; niche: string; f: LeadFilters; }
export const defaultTableFilters: TableFilters = { q: "", niche: "", f: defaultFilters };

/** A lead with a draft that hasn't been acted on yet: the "Drafts ready" view. */
export const isDraftReady = (r: LeadRow) => r.hasDraft && (r.business.lead_status === "new" || r.business.lead_status === "reviewed");

/** Everything the table filters on after the server's list: the quality filters, industry and the search box. */
export function filterLeadRows(rows: LeadRow[], t: TableFilters, now = new Date()): LeadRow[] {
  const needle = t.q.trim().toLowerCase();
  return applyLeadFilters(rows, t.f, now)
    .filter((r) => !t.niche || r.niche === t.niche)
    .filter((r) => !needle || `${r.business.name} ${r.business.website_url ?? ""} ${r.business.address ?? ""}`.toLowerCase().includes(needle));
}
