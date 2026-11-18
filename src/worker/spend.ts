import { monthUsage, type Service } from "./db/usage";
import { listSpendCaps } from "./db/spendCaps";
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

/** Same boundaries as the total: capped once spend passes the cap, warn from 80% of it. A cap of 0 is capped only after something is spent. */
function levelFor(spentUsd: number, capUsd: number): SpendLevel {
  return spentUsd > capUsd ? "capped" : spentUsd >= WARN_FRACTION * capUsd && spentUsd > 0 ? "warn" : "ok";
}

/** Month-to-date spend per service against its sub-cap: every service with usage or a cap row, sorted by name. No cap means no limit (level ok). */
export async function serviceSpend(db: D1Database, now: Date): Promise<{ service: Service; spentUsd: number; capUsd: number | null; level: SpendLevel }[]> {
  const month = now.toISOString().slice(0, 7);
  const spent = new Map((await monthUsage(db, month)).map((r) => [r.service, r.est_cost_usd]));
  const caps = new Map((await listSpendCaps(db)).map((c) => [c.service, c.monthly_usd]));
  return [...new Set([...spent.keys(), ...caps.keys()])].sort().map((service) => {
    const spentUsd = spent.get(service) ?? 0;
    const capUsd = caps.get(service) ?? null;
    return { service, spentUsd, capUsd, level: capUsd === null ? "ok" : levelFor(spentUsd, capUsd) };
  });
}

/** What stops an optional job: "total" when the month is at the total cap, the first listed service that is at its own sub-cap, or null when it may run. */
export async function optionalJobBlock(db: D1Database, now: Date, services?: Service[]): Promise<"total" | Service | null> {
  if ((await spendStatus(db, now)).level === "capped") return "total";
  if (!services?.length) return null;
  const capped = new Set((await serviceSpend(db, now)).filter((r) => r.level === "capped").map((r) => r.service));
  return services.find((s) => capped.has(s)) ?? null;
}

/**
 * Optional (unattended, nice-to-have) jobs pause once the month is at the total cap, or when any service the job uses
 * is at its own sub-cap. Approved and in-flight work is not gated by this.
 */
export async function allowOptionalJob(db: D1Database, now: Date, services?: Service[]): Promise<boolean> {
  return (await optionalJobBlock(db, now, services)) === null;
}
