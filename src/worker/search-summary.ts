import type { Search } from "./types";
import { PER_LEAD_COST, PRICES } from "./cost";
import { BRIGHTDATA_PAGE_SIZE } from "./listings/brightdata";

/** Same cut-off as the client's "Hot" tier (src/client/scoreView.ts HOT_AT); test/search-summary.test.ts keeps them equal. */
export const HOT_SCORE = 60;

/**
 * What a search has cost so far, estimated from list prices: the Maps listing pages, plus the paid per-lead steps
 * (render, AI review, draft) for each lead a full scan has finished. A quick scan has no paid per-lead steps.
 * Usage rows are not tied to a search, so this is an estimate, not an invoice.
 */
export function searchCostUsd(s: Pick<Search, "business_type" | "max_results" | "found_count" | "processed_count" | "quick_scan">): number {
  if (s.found_count === 0 || s.business_type === "import") return 0; // an import runs no listing fetch and no paid lead steps
  const listings = Math.ceil(s.max_results / BRIGHTDATA_PAGE_SIZE) * PRICES.brightdataPerRequest;
  const leads = s.quick_scan === 1 ? 0 : s.processed_count * PER_LEAD_COST;
  return Math.round((listings + leads) * 100) / 100;
}

export interface SearchSummary {
  totals: { searches: number; found: number; spentUsd: number };
  items: Record<string, { hot: number; costUsd: number }>;
}

/** Per-search hot-lead counts and estimated cost for the history list, plus the all-time totals in its header. */
export async function searchSummary(db: D1Database, searches: Search[]): Promise<SearchSummary> {
  const hot = new Map((await db.prepare(
    `SELECT sr.search_id AS id, COUNT(*) AS n FROM search_results sr
     JOIN businesses b ON b.id = sr.business_id AND b.archived_at IS NULL
     JOIN audits a ON a.business_id = sr.business_id AND a.created_at = (SELECT MAX(created_at) FROM audits WHERE business_id = a.business_id)
     WHERE a.score >= ? GROUP BY sr.search_id`,
  ).bind(HOT_SCORE).all<{ id: string; n: number }>()).results.map((r) => [r.id, r.n]));
  const totals = (await db.prepare(
    `SELECT (SELECT COUNT(*) FROM searches) AS searches, (SELECT COALESCE(SUM(found_count), 0) FROM searches) AS found,
            (SELECT COALESCE(SUM(est_cost_usd), 0) FROM usage) AS spent`,
  ).first<{ searches: number; found: number; spent: number }>())!;
  return {
    totals: { searches: totals.searches, found: totals.found, spentUsd: Math.round(totals.spent * 100) / 100 },
    items: Object.fromEntries(searches.map((s) => [s.id, { hot: hot.get(s.id) ?? 0, costUsd: searchCostUsd(s) }])),
  };
}
