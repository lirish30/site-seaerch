import type { Service } from "./usage";

export const SERVICES = ["brightdata", "places", "pagespeed", "claude", "browser", "claude_cro", "claude_agent"] as const satisfies readonly Service[];

export async function listSpendCaps(db: D1Database): Promise<{ service: Service; monthly_usd: number }[]> {
  return (await db.prepare(`SELECT service, monthly_usd FROM spend_caps ORDER BY service`).all<{ service: Service; monthly_usd: number }>()).results;
}

/** Sets a service's monthly sub-cap, or removes it when `monthlyUsd` is null. */
export async function setSpendCap(db: D1Database, service: Service, monthlyUsd: number | null): Promise<void> {
  if (monthlyUsd === null) await db.prepare(`DELETE FROM spend_caps WHERE service = ?`).bind(service).run();
  else await db.prepare(`INSERT INTO spend_caps (service, monthly_usd) VALUES (?, ?) ON CONFLICT(service) DO UPDATE SET monthly_usd = excluded.monthly_usd`).bind(service, monthlyUsd).run();
}
