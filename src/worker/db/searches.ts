import type { Search } from "../types";

export async function createSearch(
  db: D1Database,
  i: { location: string; businessType: string; radiusKm: number; maxResults: number },
  opts: { newOnly?: boolean } = {},
): Promise<Search> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO searches (id, location, business_type, radius_km, max_results, status, created_at, new_only)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).bind(id, i.location, i.businessType, i.radiusKm, Math.min(i.maxResults, 200), now, opts.newOnly ? 1 : 0).run();
  return (await getSearch(db, id))!;
}

export async function getSearch(db: D1Database, id: string): Promise<Search | null> {
  return db.prepare(`SELECT * FROM searches WHERE id = ?`).bind(id).first<Search>();
}

export async function listSearches(db: D1Database): Promise<Search[]> {
  return (await db.prepare(`SELECT * FROM searches ORDER BY created_at DESC LIMIT 100`).all<Search>()).results;
}

export async function setSearchStatus(db: D1Database, id: string, status: Search["status"], error: string | null = null) {
  await db.prepare(`UPDATE searches SET status = ?, error = ? WHERE id = ?`).bind(status, error, id).run();
}

export async function setFoundCount(db: D1Database, id: string, n: number) {
  await db.prepare(`UPDATE searches SET found_count = ? WHERE id = ?`).bind(n, id).run();
}

export async function incrementProcessed(db: D1Database, id: string) {
  await db.prepare(`UPDATE searches SET processed_count = processed_count + 1 WHERE id = ?`).bind(id).run();
}

export async function setProcessedCount(db: D1Database, id: string, n: number) {
  await db.prepare(`UPDATE searches SET processed_count = ? WHERE id = ?`).bind(n, id).run();
}

/** max_results of searches still running that were created at or after `sinceIso`. */
export async function runningMaxResultsSince(db: D1Database, sinceIso: string): Promise<number[]> {
  return (await db.prepare(`SELECT max_results FROM searches WHERE status = 'running' AND created_at > ?`).bind(sinceIso).all<{ max_results: number }>())
    .results.map((r) => r.max_results);
}
