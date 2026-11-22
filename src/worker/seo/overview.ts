import { listKeywords, rankChecksFor, type RankPoint } from "../db/seo";
import { isUsable } from "./grid";

// What the owner's Local SEO views and the MCP tool read about one client (Plan 14): the latest rank grid per search term and what is waiting on Logan. Only counts and the app's own numbers: nothing a stranger wrote.

/** A point at this position or better counts as "visible", the same rule the report uses. */
const VISIBLE_AT = 3;

export interface GridRow {
  term: string;
  town: string | null;
  /** The nine points row by row from the north-west: `pos` null with `ok` true is "not in the top 20", `ok` false is "not checked". Where they are on the map is left out. */
  points: { pos: number | null; ok: boolean }[];
  /** How many points were measured (`ok`). */
  measured: number;
  /** The booking-zone date of the check. */
  takenOn: string;
}

/** A stored point as it is shown: one that cannot be read (no true or false for `ok`, or a position that is not a whole number from 1 to 100) is "not checked", never a guess at "not found". */
function cleanPoint(p: RankPoint): { pos: number | null; ok: boolean } {
  if (!p || p.ok !== true) return { pos: null, ok: false };
  if (p.pos === null) return { pos: null, ok: true };
  return Number.isInteger(p.pos) && p.pos >= 1 && p.pos <= 100 ? { pos: p.pos, ok: true } : { pos: null, ok: false };
}

/** The latest rank check of every active keyword of the client, in keyword order; a keyword with no check yet is left out. */
export async function latestGrid(db: D1Database, businessId: string): Promise<GridRow[]> {
  const keywords = await listKeywords(db, businessId, { activeOnly: true });
  if (!keywords.length) return [];
  const checks = await rankChecksFor(db, businessId, {});
  const out: GridRow[] = [];
  for (const k of keywords) {
    const last = checks.filter((c) => c.keywordId === k.id).at(-1);
    if (!last) continue;
    const points = last.points.slice(0, 9).map(cleanPoint);
    out.push({ term: k.term, town: k.town.trim() === "" ? null : k.town, points, measured: points.filter((p) => p.ok).length, takenOn: last.takenOn });
  }
  return out;
}

/** How many of the grid's points showed the business at position 3 or better, or null when too few points were measured for the check to say. */
export function visiblePoints(points: { pos: number | null; ok: boolean }[]): number | null {
  return isUsable(points.map((p) => ({ lat: 0, lng: 0, ...p }))) ? points.filter((p) => p.ok && p.pos !== null && p.pos <= VISIBLE_AT).length : null;
}

export interface Waiting {
  /** Review replies written and waiting for Logan (`drafted`). */
  replies: number;
  /** Content written and waiting for Logan (`drafted`). */
  content: number;
  /** Low-rated (flagged) reviews that are not yet `posted` or `skipped`. */
  flagged: number;
}

/** What waits on Logan for one client, counts only. */
export async function waitingFor(db: D1Database, businessId: string): Promise<Waiting> {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM seo_reviews WHERE business_id = ?1 AND reply_status = 'drafted') AS replies,
            (SELECT COUNT(*) FROM seo_content WHERE business_id = ?1 AND status = 'drafted') AS content,
            (SELECT COUNT(*) FROM seo_reviews WHERE business_id = ?1 AND flagged = 1 AND reply_status NOT IN ('posted', 'skipped')) AS flagged`,
  ).bind(businessId).first<Waiting>();
  return r ?? { replies: 0, content: 0, flagged: 0 };
}
