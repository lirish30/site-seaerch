import { getReportByToken } from "../db/careReports";
import { getVideoFor, type ReportKind } from "../db/reportVideos";
import { getSeoReportByToken } from "../db/seoReports";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { serveObject } from "../video/media";

/** The stored file of a report's finished video, or null: the report is not `sent`, or it has no video, or the video is queued, failed or discarded. The one test both the report page's `video` flag and the stream use. */
export async function videoKeyOf(db: D1Database, kind: ReportKind, report: { id: string; status: string }): Promise<string | null> {
  if (report.status !== "sent") return null;
  const video = await getVideoFor(db, kind, report.id);
  return video?.status === "rendered" ? video.videoKey : null;
}

/**
 * The MP4 of the report behind a link, streamed with byte ranges so a player can seek, or null. Null is one answer for a malformed token (never looked up), an unknown one, a report that is not `sent` and a
 * video that is not rendered, so the caller cannot tell them apart. No view is counted: the page is what counts.
 */
export async function serveReportVideo(env: Pick<Env, "DB" | "RAW">, kind: ReportKind, token: string, range: string | null): Promise<Response | null> {
  if (!isClientToken(token)) return null;
  const report = kind === "care" ? await getReportByToken(env.DB, token) : await getSeoReportByToken(env.DB, token);
  const key = report && (await videoKeyOf(env.DB, kind, report));
  return key ? serveObject(env.RAW, key, "video/mp4", range) : null;
}
