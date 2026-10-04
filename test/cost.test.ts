import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { estimateSearchCost, checkSpend, PRICES, PER_LEAD_COST } from "../src/worker/cost";
import { recordUsage } from "../src/worker/db/usage";
import { saveSettings } from "../src/worker/db/settings";

describe("cost", () => {
  it("estimates listing pages + per-lead render, review and draft", () => {
    expect(PER_LEAD_COST).toBeCloseTo(PRICES.browserPerRender + PRICES.claudePerReview + PRICES.claudePerDraft);
    expect(estimateSearchCost(50)).toBeCloseTo(3 * PRICES.brightdataPerRequest + 50 * PER_LEAD_COST);
  });

  it("blocks when this month's spend + estimate exceeds limit", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 1 });
    await recordUsage(env.DB, "claude", 90, 0.9);
    expect((await checkSpend(env.DB, 0.05)).ok).toBe(true);
    expect((await checkSpend(env.DB, 0.2)).ok).toBe(false);
  });
});
