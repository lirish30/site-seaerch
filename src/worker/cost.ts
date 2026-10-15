import { monthUsage } from "./db/usage";
import { getSettings } from "./db/settings";
import { BRIGHTDATA_PAGE_SIZE } from "./listings/brightdata";

// Rough list prices; update when invoices disagree.
// browserPerRender: ~20s of Browser Rendering at $0.09/browser-hour. claudePerReview / claudePerDraft / croAudit were sized
// for Sonnet 5.5 and Haiku 4.5; Haiku 5.5 ($0.10/$0.50 per MTok) now costs a fraction, so they are conservative spend-cap ceilings.
export const PRICES = { brightdataPerRequest: 0.0015, pagespeedPerCall: 0, claudePerDraft: 0.01, browserPerRender: 0.0005, claudePerReview: 0.035, croAudit: 0.25 };

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
