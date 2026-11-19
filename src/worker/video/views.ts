import { z } from "zod";
import type { Env } from "../env";
import { publishedVideoForToken } from "../db/reports";

export const SESSIONS_PER_DAY = 50;
/** The most a beacon body may be. A real one is about 80 bytes. */
export const MAX_EVENT_BYTES = 200;
const DAY_MS = 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

export const EVENT_TYPES = ["open", "play", "progress", "end"] as const;
export interface ViewEvent { session: string; type: (typeof EVENT_TYPES)[number]; pct?: number }

/** The beacon's JSON body. Anything else (an unknown key, a fractional or missing `pct` on a progress event) is not stored. */
export const ViewEventSchema = z.object({
  session: z.string().regex(SESSION),
  type: z.enum(EVENT_TYPES),
  pct: z.number().int().optional(),
}).strict().refine((e) => e.type !== "progress" || e.pct !== undefined);

// What the lead's activity says, once per link. `mark` is the row in video_view_marks that makes "once" true.
const MILESTONES = {
  play: { detail: "Watched the video audit" },
  p50: { detail: "Watched 50% of the video" },
  p90: { detail: "Watched 90% of the video" },
} as const;
type Mark = keyof typeof MILESTONES;

/** A milestone the event reaches. The `end` counts as 100%, so it reaches 50 and 90 even when the progress beacons never arrived. */
function reached(e: ViewEvent): Mark[] {
  if (e.type === "play") return ["play"];
  const pct = e.type === "end" ? 100 : e.type === "progress" ? e.pct ?? 0 : 0;
  return [...(pct >= 50 ? ["p50" as const] : []), ...(pct >= 90 ? ["p90" as const] : [])];
}

/**
 * Stores one beacon from the report page. Nothing is stored (and nothing is said) for an unknown, expired or revoked link, a video that is not
 * published, a malformed event, a `pct` outside 0-100, or a new session once the link already has 50 in the last 24 hours; events for a session that
 * already exists are always kept. `max_pct` only rises. The first play, the first time the video is half watched and the first time it is
 * (almost) finished each go to the lead's activity once per link: a marker row is inserted first and the activity row follows only when that insert
 * took, in the same batch, so two beacons at once cannot both log it.
 */
export async function recordEvent(env: Pick<Env, "DB">, token: string, e: ViewEvent, now: Date): Promise<void> {
  if (!TOKEN.test(token) || typeof e.session !== "string" || !SESSION.test(e.session) || !EVENT_TYPES.includes(e.type)) return;
  if (e.pct !== undefined && !(Number.isInteger(e.pct) && e.pct >= 0 && e.pct <= 100)) return;
  if (e.type === "progress" && e.pct === undefined) return;
  const video = await publishedVideoForToken(env.DB, token, now);
  if (!video) return;

  const at = now.toISOString();
  const pct = e.type === "end" ? 100 : e.type === "progress" ? e.pct! : 0;
  // One statement: a new session is added only while the link has fewer than the cap in the last 24 hours; an existing one is always updated.
  const r = await env.DB.prepare(
    `INSERT INTO video_sessions (token, session, first_at, last_at, opened, plays, max_pct)
     SELECT ?1, ?2, ?3, ?3, ?4, ?5, ?6
     WHERE EXISTS (SELECT 1 FROM video_sessions WHERE token = ?1 AND session = ?2)
        OR (SELECT COUNT(*) FROM video_sessions WHERE token = ?1 AND first_at > ?7) < ?8
     ON CONFLICT (token, session) DO UPDATE SET last_at = excluded.last_at, opened = MAX(opened, excluded.opened),
       plays = plays + excluded.plays, max_pct = MAX(max_pct, excluded.max_pct)`,
  ).bind(token, e.session, at, e.type === "open" ? 1 : 0, e.type === "play" ? 1 : 0, pct, new Date(now.getTime() - DAY_MS).toISOString(), SESSIONS_PER_DAY).run();
  if (!r.meta.changes) return;

  const marks = reached(e);
  if (!marks.length) return;
  await env.DB.batch(marks.flatMap((m, i) => [
    env.DB.prepare(`INSERT OR IGNORE INTO video_view_marks (token, mark, at) VALUES (?,?,?)`).bind(token, m, at),
    // changes() is the marker insert's: 1 when this beacon won the marker, 0 when it was already there. The offset keeps the entries in order on the timeline.
    env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) SELECT ?,?,?,?,? WHERE changes() > 0`)
      .bind(crypto.randomUUID(), video.business_id, "video_watch", MILESTONES[m].detail, new Date(now.getTime() + i).toISOString()),
  ]));
}

export interface WatchedLead { businessId: string; name: string; maxPct: number; lastAt: string }

/**
 * Leads whose video was watched at least halfway in the last 7 days and who have not answered since: not replied, won, lost or skipped (nor archived).
 * One row per lead (its deepest watch, and when it last watched), newest first, at most 10.
 */
export async function watchedLeads(db: D1Database, now: Date): Promise<WatchedLead[]> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  return (await db.prepare(
    `SELECT b.id AS businessId, b.name AS name, MAX(s.max_pct) AS maxPct, MAX(s.last_at) AS lastAt
     FROM video_sessions s JOIN audit_reports r ON r.token = s.token JOIN businesses b ON b.id = r.business_id
     WHERE s.last_at >= ? AND s.max_pct >= 50 AND b.lead_status NOT IN ('replied','won','lost','skip') AND b.archived_at IS NULL
     GROUP BY b.id ORDER BY lastAt DESC, b.id LIMIT 10`,
  ).bind(since).all<WatchedLead>()).results;
}

/** A lead's deepest watch of any of its report links, and when it last watched; null when nobody has watched any of it. */
export async function watchedFor(db: D1Database, businessId: string): Promise<{ maxPct: number; lastAt: string } | null> {
  const r = await db.prepare(
    `SELECT MAX(s.max_pct) AS maxPct, MAX(s.last_at) AS lastAt FROM video_sessions s JOIN audit_reports r ON r.token = s.token
     WHERE r.business_id = ? AND s.max_pct > 0`,
  ).bind(businessId).first<{ maxPct: number | null; lastAt: string | null }>();
  return r?.maxPct && r.lastAt ? { maxPct: r.maxPct, lastAt: r.lastAt } : null;
}
