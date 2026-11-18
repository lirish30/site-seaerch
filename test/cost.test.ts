import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { estimateSearchCost, checkSpend, PRICES, PER_LEAD_COST } from "../src/worker/cost";
import { recordUsage } from "../src/worker/db/usage";
import { saveSettings } from "../src/worker/db/settings";

describe("cost", () => {
  it("prices nothing for Claude: a lead costs its render only", () => {
    expect(Object.keys(PRICES).filter((k) => /claude|cro/i.test(k))).toEqual([]);
    expect(PER_LEAD_COST).toBe(PRICES.browserPerRender);
  });

  it("estimates listing pages + one render per lead", () => {
    expect(estimateSearchCost(50)).toBeCloseTo(3 * PRICES.listingPerRequest + 50 * PRICES.browserPerRender);
    expect(estimateSearchCost(50)).toBeCloseTo(0.13, 10);
  });

  it("blocks when this month's spend + estimate exceeds limit", async () => {
    await env.DB.prepare(`UPDATE fixed_costs SET active = 0`).run(); // metered usage only
    await saveSettings(env.DB, { monthly_spend_limit_usd: 1 });
    await recordUsage(env.DB, "claude", 90, 0.9);
    expect((await checkSpend(env.DB, 0.05)).ok).toBe(true);
    expect((await checkSpend(env.DB, 0.2)).ok).toBe(false);
  });
});
