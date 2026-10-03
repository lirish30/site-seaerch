export type Service = "brightdata" | "pagespeed" | "claude";

export async function recordUsage(db: D1Database, service: Service, units: number, estCostUsd: number) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), now.slice(0, 7), service, units, estCostUsd, now).run();
}

export async function monthUsage(db: D1Database, month: string) {
  return (await db.prepare(
    `SELECT service, SUM(units) AS units, SUM(est_cost_usd) AS est_cost_usd FROM usage WHERE month = ? GROUP BY service`,
  ).bind(month).all<{ service: Service; units: number; est_cost_usd: number }>()).results;
}
