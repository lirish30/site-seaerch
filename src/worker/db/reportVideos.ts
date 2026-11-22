// Report videos (Plan 16): the short video that goes with a Care or Local SEO report, one per report.
// Times are UTC ISO strings with milliseconds. `video_key` and `poster_key` are keys in the files bucket.

export type ReportKind = "care" | "seo";
export type VideoStatus = "queued" | "rendered" | "failed" | "discarded";

export interface ReportVideo {
  id: string; reportKind: ReportKind; reportId: string; status: VideoStatus; videoKey: string | null; posterKey: string | null; durationMs: number | null; error: string; createdAt: string;
}

interface Row {
  id: string; report_kind: ReportKind; report_id: string; status: VideoStatus; video_key: string | null; poster_key: string | null; duration_ms: number | null; error: string; created_at: string;
}

const toVideo = (r: Row): ReportVideo => ({
  id: r.id, reportKind: r.report_kind, reportId: r.report_id, status: r.status, videoKey: r.video_key, posterKey: r.poster_key, durationMs: r.duration_ms, error: r.error, createdAt: r.created_at,
});

export async function getVideoFor(db: D1Database, kind: ReportKind, reportId: string): Promise<ReportVideo | null> {
  const r = await db.prepare(`SELECT * FROM report_videos WHERE report_kind = ? AND report_id = ?`).bind(kind, reportId).first<Row>();
  return r ? toVideo(r) : null;
}

/** Queues the video of a report, once: a second call (or a racing one) changes nothing and returns the row that is there, with `created: false`. */
export async function insertVideo(db: D1Database, p: { kind: ReportKind; reportId: string; now: string }): Promise<{ video: ReportVideo; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO report_videos (id, report_kind, report_id, status, created_at) VALUES (?, ?, ?, 'queued', ?) ON CONFLICT (report_kind, report_id) DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), p.kind, p.reportId, p.now).first<Row>();
  if (made) return { video: toVideo(made), created: true };
  const existing = await getVideoFor(db, p.kind, p.reportId);
  if (!existing) throw new Error("could not queue the report video");
  return { video: existing, created: false };
}

/** `queued` to `rendered`; false when it was not queued. */
export async function finishVideo(db: D1Database, id: string, p: { videoKey: string; posterKey: string; durationMs: number }): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE report_videos SET status = 'rendered', video_key = ?, poster_key = ?, duration_ms = ?, error = '' WHERE id = ? AND status = 'queued'`,
  ).bind(p.videoKey, p.posterKey, p.durationMs, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Notes that the render failed, in plain words, while the video is still queued. */
export async function failVideo(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`UPDATE report_videos SET status = 'failed', error = ? WHERE id = ? AND status = 'queued'`).bind(error, id).run();
}
