import type { Radar } from "../types";
import { chunks } from "./chunks";

export const MAX_RADARS = 20;
export const DAY_MS = 86400000;
export const addDays = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS).toISOString();

export async function getRadar(db: D1Database, id: string): Promise<Radar | null> {
  return db.prepare(`SELECT * FROM radars WHERE id = ?`).bind(id).first<Radar>();
}

export async function countRadars(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM radars`).first<{ n: number }>())!.n;
}

export async function radarExists(db: D1Database, location: string, businessType: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM radars WHERE location = ? COLLATE NOCASE AND business_type = ? COLLATE NOCASE`).bind(location, businessType).first());
}

/** Throws the D1 UNIQUE error for a duplicate market; callers turn it into a 409 via `isDuplicateMarket`. */
export async function createRadar(
  db: D1Database,
  i: { location: string; businessType: string; radiusKm: number; maxResults: number; intervalDays: number },
  nextRunAt: string,
): Promise<Radar> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(id, i.location, i.businessType, i.radiusKm, i.maxResults, i.intervalDays, nextRunAt, new Date().toISOString()).run();
  return (await getRadar(db, id))!;
}

export const isDuplicateMarket = (e: unknown) => /UNIQUE/i.test(String((e as Error)?.message ?? e));

export async function deleteRadar(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM radars WHERE id = ?`).bind(id).run()).meta.changes ?? 0) === 1;
}

export async function listDueRadars(db: D1Database, nowIso: string, limit: number): Promise<Radar[]> {
  return (await db.prepare(`SELECT * FROM radars WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?`)
    .bind(nowIso, limit).all<Radar>()).results;
}

// A radar can be claimed at most once per this window, however the claims interleave.
export const CLAIM_COOLDOWN_MS = 10_000;

/**
 * Single-statement claim (compare-and-set): moves next_run_at out and stamps claimed_at, and returns the radar
 * only for the one caller that wins. Cron claims also require the radar to be due right now, so a stale snapshot
 * (e.g. one since blocked and pushed to tomorrow) cannot be claimed; manual claims skip the due check. The cooldown
 * lives in the WHERE clause, so a double-click or overlapping cron delivery cannot start it twice.
 */
export async function claimRadar(db: D1Database, id: string, newNextRunAt: string, nowIso: string, dueOnly: boolean): Promise<Radar | null> {
  const cooldownEnd = new Date(new Date(nowIso).getTime() - CLAIM_COOLDOWN_MS).toISOString();
  return db.prepare(
    `UPDATE radars SET next_run_at = ?, claimed_at = ? WHERE id = ? AND enabled = 1${dueOnly ? " AND next_run_at <= ?" : ""}
     AND (claimed_at IS NULL OR claimed_at < ?) RETURNING *`,
  ).bind(newNextRunAt, nowIso, id, ...(dueOnly ? [nowIso] : []), cooldownEnd).first<Radar>();
}

export async function recordRadarStarted(db: D1Database, id: string, searchId: string, nowIso: string) {
  await db.prepare(`UPDATE radars SET last_run_at = ?, last_search_id = ?, last_error = NULL WHERE id = ?`).bind(nowIso, searchId, id).run();
}

export async function recordRadarBlocked(db: D1Database, id: string, error: string, nextRunAt: string) {
  await db.prepare(`UPDATE radars SET last_error = ?, next_run_at = ? WHERE id = ?`).bind(error.slice(0, 500), nextRunAt, id).run();
}

export async function updateRadar(db: D1Database, id: string, p: { enabled?: boolean; intervalDays?: number; nextRunAt?: string }) {
  const sets: string[] = []; const vals: unknown[] = [];
  if (p.enabled !== undefined) { sets.push("enabled = ?"); vals.push(p.enabled ? 1 : 0); }
  if (p.intervalDays !== undefined) { sets.push("interval_days = ?"); vals.push(p.intervalDays); }
  if (p.nextRunAt !== undefined) { sets.push("next_run_at = ?"); vals.push(p.nextRunAt); }
  if (sets.length) await db.prepare(`UPDATE radars SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
}

export type RadarListItem = Radar & { newLeadCount: number; lastSearchStatus: string | null };

/** Newest first. newLeadCount = businesses first discovered by the radar's most recent search. */
export async function listRadars(db: D1Database): Promise<RadarListItem[]> {
  const rows = (await db.prepare(
    `SELECT r.*, s.status AS lastSearchStatus FROM radars r LEFT JOIN searches s ON s.id = r.last_search_id ORDER BY r.created_at DESC, r.id DESC`,
  ).all<Radar & { lastSearchStatus: string | null }>()).results;
  const ids = [...new Set(rows.map((r) => r.last_search_id).filter((x): x is string => !!x))];
  const counts = new Map<string, number>();
  for (const part of chunks(ids)) {
    const res = (await db.prepare(
      `SELECT first_seen_search_id AS id, COUNT(*) AS n FROM businesses WHERE first_seen_search_id IN (${part.map(() => "?").join(",")}) GROUP BY first_seen_search_id`,
    ).bind(...part).all<{ id: string; n: number }>()).results;
    for (const r of res) counts.set(r.id, r.n);
  }
  return rows.map((r) => ({ ...r, newLeadCount: r.last_search_id ? counts.get(r.last_search_id) ?? 0 : 0 }));
}
