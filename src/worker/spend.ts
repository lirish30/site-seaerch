import { monthUsage } from "./db/usage";
import { getSettings } from "./db/settings";
import { activeFixedUsd } from "./db/fixedCosts";

export type SpendLevel = "ok" | "warn" | "capped";
export const WARN_FRACTION = 0.8;

/** Month-to-date spend: metered usage plus active fixed monthly costs, against the single monthly cap. */
export async function spendStatus(db: D1Database, now: Date, extraUsd = 0): Promise<{
  month: string; variableUsd: number; fixedUsd: number; spentUsd: number; limitUsd: number; level: SpendLevel; ok: boolean;
}> {
  const month = now.toISOString().slice(0, 7);
  const variableUsd = (await monthUsage(db, month)).reduce((s, r) => s + r.est_cost_usd, 0);
  const fixedUsd = await activeFixedUsd(db);
  const limitUsd = (await getSettings(db)).monthly_spend_limit_usd;
  const spentUsd = variableUsd + fixedUsd;
  const level: SpendLevel = spentUsd + extraUsd > limitUsd ? "capped" : spentUsd >= WARN_FRACTION * limitUsd ? "warn" : "ok";
  return { month, variableUsd, fixedUsd, spentUsd, limitUsd, level, ok: level !== "capped" };
}

/** Optional (unattended, nice-to-have) jobs pause once the month is at the cap; approved and in-flight work is not gated by this. */
export async function allowOptionalJob(db: D1Database, now: Date): Promise<boolean> {
  return (await spendStatus(db, now)).level !== "capped";
}
