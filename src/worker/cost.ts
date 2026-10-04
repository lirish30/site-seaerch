import { monthUsage } from "./db/usage";
import { getSettings } from "./db/settings";
import { BRIGHTDATA_PAGE_SIZE } from "./listings/brightdata";

// Rough list prices; update when invoices disagree.
// browserPerRender: ~20s of Browser Rendering at $0.09/browser-hour. claudePerReview: Sonnet 5.5 with two
// screenshots (~6k input, ~2k output incl. thinking at $2/$10 per MTok).
export const PRICES = { brightdataPerRequest: 0.0015, pagespeedPerCall: 0, claudePerDraft: 0.01, browserPerRender: 0.0005, claudePerReview: 0.035 };

export const PER_LEAD_COST = PRICES.browserPerRender + PRICES.claudePerReview + PRICES.claudePerDraft;

export function estimateSearchCost(maxResults: number): number {
  const pages = Math.ceil(maxResults / BRIGHTDATA_PAGE_SIZE);
  return pages * PRICES.brightdataPerRequest + maxResults * PER_LEAD_COST;
}

export async function checkSpend(db: D1Database, extraUsd: number) {
  const month = new Date().toISOString().slice(0, 7);
  const spent = (await monthUsage(db, month)).reduce((s, r) => s + r.est_cost_usd, 0);
  const limit = (await getSettings(db)).monthly_spend_limit_usd;
  return { ok: spent + extraUsd <= limit, spent, limit };
}
