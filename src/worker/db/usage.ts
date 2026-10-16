export type Service = "brightdata" | "places" | "pagespeed" | "claude" | "browser" | "claude_cro";

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

/** The `count` months ending at `endMonth` ("YYYY-MM"), oldest first. */
export function lastMonths(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** Estimated spend per month for the last `count` months, zero-filled so a quiet month still shows. */
export async function monthlySpend(db: D1Database, endMonth: string, count = 6): Promise<{ month: string; est_cost_usd: number }[]> {
  const months = lastMonths(endMonth, count);
  const rows = (await db.prepare(`SELECT month, SUM(est_cost_usd) AS est_cost_usd FROM usage WHERE month >= ? AND month <= ? GROUP BY month`)
    .bind(months[0], endMonth).all<{ month: string; est_cost_usd: number }>()).results;
  const by = new Map(rows.map((r) => [r.month, r.est_cost_usd]));
  return months.map((month) => ({ month, est_cost_usd: by.get(month) ?? 0 }));
}
