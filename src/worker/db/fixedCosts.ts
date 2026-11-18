export type FixedCost = { id: string; name: string; monthly_usd: number; active: 0 | 1 };

export async function listFixedCosts(db: D1Database): Promise<FixedCost[]> {
  return (await db.prepare(`SELECT id, name, monthly_usd, active FROM fixed_costs ORDER BY created_at, id`).all<FixedCost>()).results;
}

export async function setFixedCostActive(db: D1Database, id: string, active: boolean): Promise<void> {
  await db.prepare(`UPDATE fixed_costs SET active = ? WHERE id = ?`).bind(active ? 1 : 0, id).run();
}

export async function activeFixedUsd(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(monthly_usd), 0) AS n FROM fixed_costs WHERE active = 1`).first<{ n: number }>();
  return r?.n ?? 0;
}
