export interface SavedFilter { id: string; name: string; query: string; created_at: string }

export const MAX_FILTERS = 50;
export class FilterLimit extends Error {}
export class FilterNameTaken extends Error {}

export async function listFilters(db: D1Database): Promise<SavedFilter[]> {
  return (await db.prepare(`SELECT * FROM saved_filters ORDER BY created_at DESC, id DESC`).all<SavedFilter>()).results;
}

/** Names are unique ignoring case (the unique index backs the check up). */
export async function createFilter(db: D1Database, f: { name: string; query: string }): Promise<SavedFilter> {
  const taken = await db.prepare(`SELECT 1 FROM saved_filters WHERE name = ? COLLATE NOCASE`).bind(f.name).first();
  if (taken) throw new FilterNameTaken();
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM saved_filters`).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_FILTERS) throw new FilterLimit();
  const row = { id: crypto.randomUUID(), name: f.name, query: f.query, created_at: new Date().toISOString() };
  try {
    await db.prepare(`INSERT INTO saved_filters (id, name, query, created_at) VALUES (?,?,?,?)`).bind(row.id, row.name, row.query, row.created_at).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message))) throw new FilterNameTaken();
    throw e;
  }
  return row;
}

export async function deleteFilter(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM saved_filters WHERE id = ?`).bind(id).run()).meta.changes ?? 0) > 0;
}
