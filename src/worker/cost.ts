import { spendStatus } from "./spend";
import { BRIGHTDATA_PAGE_SIZE } from "./listings/brightdata";

// Rough list prices; update when invoices disagree. placesPerRequest is the Text Search Enterprise SKU (phone/website/rating)
// beyond its free monthly allowance; listingPerRequest is the dearer of the two listing providers, used for spend-cap estimates.
// browserPerRender: ~20s of Browser Rendering at $0.09/browser-hour. Claude work runs on the user's subscription via the task
// queue, so it has no price here; usage rows recorded under the claude services before that move are still read as they were.
export const PRICES = { brightdataPerRequest: 0.0015, placesPerRequest: 0.035, listingPerRequest: 0.035, pagespeedPerCall: 0, browserPerRender: 0.0005 };

/** What one lead costs once its listing is fetched: the browser render (review and draft are Claude work, which is free). */
export const PER_LEAD_COST = PRICES.browserPerRender;

export function estimateSearchCost(maxResults: number): number {
  const pages = Math.ceil(maxResults / BRIGHTDATA_PAGE_SIZE);
  return pages * PRICES.listingPerRequest + maxResults * PRICES.browserPerRender;
}

/** What a quick scan costs: the Maps listing pages only (crawl and score are free; render, review and draft wait for the full scan). */
export function estimateQuickSearchCost(maxResults: number): number {
  return Math.ceil(maxResults / BRIGHTDATA_PAGE_SIZE) * PRICES.listingPerRequest;
}

export async function checkSpend(db: D1Database, extraUsd: number) {
  const s = await spendStatus(db, new Date(), extraUsd);
  return { ok: s.ok, spent: s.spentUsd, limit: s.limitUsd };
}
