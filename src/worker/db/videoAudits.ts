import type { VideoPlan } from "../video/plan";

export const VIDEO_STATUSES = ["capturing", "scripting", "review", "producing", "rendered", "published", "failed", "cancelled"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export interface VideoAudit {
  id: string; business_id: string; audit_id: string; status: VideoStatus; plan: VideoPlan | null; steering_note: string | null;
  video_key: string | null; gif_key: string | null; poster_key: string | null; duration_ms: number | null;
  publish_approval_id: string | null; error: string | null; created_at: string; updated_at: string; published_at: string | null;
}
type VideoRow = Omit<VideoAudit, "plan"> & { plan: string | null };

const toVideo = (r: VideoRow): VideoAudit => ({ ...r, plan: r.plan === null ? null : (JSON.parse(r.plan) as VideoPlan) });

/** Starts a video for an audit, or returns null when that audit already has an open one (anything but failed or cancelled). */
export async function createVideoAudit(db: D1Database, o: { businessId: string; auditId: string }): Promise<VideoAudit | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO video_audits (id, business_id, audit_id, status, created_at, updated_at) VALUES (?,?,?,'capturing',?,?) ON CONFLICT DO NOTHING`,
  ).bind(id, o.businessId, o.auditId, now, now).run();
  if (!r.meta.changes) return null;
  return (await getVideoAudit(db, id))!;
}

export async function getVideoAudit(db: D1Database, id: string): Promise<VideoAudit | null> {
  const r = await db.prepare(`SELECT * FROM video_audits WHERE id = ?`).bind(id).first<VideoRow>();
  return r ? toVideo(r) : null;
}

/** The business's newest video, whatever its status. */
export async function latestVideoFor(db: D1Database, businessId: string): Promise<VideoAudit | null> {
  const r = await db.prepare(`SELECT * FROM video_audits WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(businessId).first<VideoRow>();
  return r ? toVideo(r) : null;
}

/**
 * Stores the plan and bumps its version in the same statement: the new version is the stored one plus one (0 when nothing was stored),
 * whatever version the caller's copy carries. Returns the plan as stored.
 */
export async function savePlan(db: D1Database, id: string, plan: VideoPlan): Promise<VideoPlan> {
  await db.prepare(
    `UPDATE video_audits SET plan = json_set(?, '$.version', COALESCE(json_extract(plan, '$.version'), 0) + 1), updated_at = ? WHERE id = ?`,
  ).bind(JSON.stringify(plan), new Date().toISOString(), id).run();
  const v = await getVideoAudit(db, id);
  if (!v?.plan) throw new Error(`video ${id} not found`);
  return v.plan;
}

export type VideoPatch = Partial<Pick<VideoAudit, "steering_note" | "video_key" | "gif_key" | "poster_key" | "duration_ms" | "publish_approval_id" | "error">>;
const PATCH_COLUMNS = ["steering_note", "video_key", "gif_key", "poster_key", "duration_ms", "publish_approval_id", "error"] as const;

function statusUpdate(status: VideoStatus, patch: VideoPatch): { sets: string[]; binds: unknown[] } {
  const now = new Date().toISOString();
  const sets = ["status = ?", "updated_at = ?"];
  const binds: unknown[] = [status, now];
  for (const c of PATCH_COLUMNS) {
    if (patch[c] !== undefined) { sets.push(`${c} = ?`); binds.push(patch[c]); }
  }
  if (status === "published") { sets.push("published_at = ?"); binds.push(now); }
  return { sets, binds };
}

/** Moves a video to a status and updates only the columns the patch names (null clears one). Entering `published` stamps published_at. */
export async function setVideoStatus(db: D1Database, id: string, status: VideoStatus, patch: VideoPatch = {}): Promise<VideoAudit | null> {
  const { sets, binds } = statusUpdate(status, patch);
  await db.prepare(`UPDATE video_audits SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return getVideoAudit(db, id);
}

/**
 * The same move, but only when the video is in one of the `from` statuses right now, decided in the one statement so that two callers cannot both win.
 * Returns whether this call moved it.
 */
export async function moveVideoStatus(db: D1Database, id: string, from: readonly VideoStatus[], to: VideoStatus, patch: VideoPatch = {}): Promise<boolean> {
  const { sets, binds } = statusUpdate(to, patch);
  const marks = from.map(() => "?").join(",");
  const r = await db.prepare(`UPDATE video_audits SET ${sets.join(", ")} WHERE id = ? AND status IN (${marks})`).bind(...binds, id, ...from).run();
  return r.meta.changes > 0;
}

/** The audit's published video, if it has one. */
export async function publishedVideoForAudit(db: D1Database, auditId: string): Promise<VideoAudit | null> {
  const r = await db.prepare(`SELECT * FROM video_audits WHERE audit_id = ? AND status = 'published' ORDER BY published_at DESC, rowid DESC LIMIT 1`).bind(auditId).first<VideoRow>();
  return r ? toVideo(r) : null;
}
