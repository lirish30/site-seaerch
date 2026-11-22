import { ReportFacts } from "../care/reportFacts";
import { getReport } from "../db/careReports";
import { failVideo, finishVideo, getVideo, getVideoFor, insertVideo, resetVideo, type ReportKind } from "../db/reportVideos";
import { getSeoReport } from "../db/seoReports";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { enqueueHelperJob } from "../helper/jobs";
import { HelperRefused } from "../helper/registry";
import { REPORT_RENDER_KIND, reportVideoKeys, type ReportRenderPayload, type ReportRenderResult } from "../helper/kinds";
import { SeoReportFacts } from "../seo/reportFacts";
import { buildScenes, type Scene } from "./videoScenes";

// The short silent video of a Care or Local SEO report (Plan 16), made on the owner's Mac by the same helper that renders the audit video. One video per report, built only from its frozen facts.

/** The scenes of a report's frozen facts, or none (the report is gone, its numbers cannot be read, or there is too little to show). */
async function scenesOf(env: Env, kind: ReportKind, reportId: string): Promise<Scene[]> {
  const report = kind === "care" ? await getReport(env.DB, reportId) : await getSeoReport(env.DB, reportId);
  if (!report) return [];
  const facts = kind === "care" ? ReportFacts.safeParse(report.facts) : SeoReportFacts.safeParse(report.facts);
  return facts.success ? buildScenes(kind, facts.data) : [];
}

/** Queues the render, once per report: the dedupe key is the report, so a crash-retry or a racing call queues one job. The job carries the scenes and the two files the helper may write; the worker says what they are. */
async function queueJob(env: Env, kind: ReportKind, reportId: string, videoId: string, scenes: Scene[]): Promise<void> {
  const settings = await getSettings(env.DB);
  const k = reportVideoKeys(kind, reportId);
  const payload: ReportRenderPayload = {
    videoId, scenes, brand: { name: (settings.business_name.trim() || settings.your_name.trim() || "Siteline").slice(0, 80) }, outputs: [k.mp4, k.jpg],
  };
  await enqueueHelperJob(env.DB, REPORT_RENDER_KIND, payload, { dedupeKey: `${kind}:${reportId}` });
}

/**
 * Queues the video of a report whose words were just stored. Does nothing when the report is gone, its numbers cannot be read or there are fewer than three scenes to show. A video that already exists
 * is never made again: a `queued` one only gets its job back if a crash lost it (the dedupe key makes that a no-op while a job is open), and a `failed` one waits for a deliberate `retryReportVideo`.
 */
export async function enqueueReportVideo(env: Env, kind: ReportKind, reportId: string): Promise<void> {
  const scenes = await scenesOf(env, kind, reportId);
  if (!scenes.length) return;
  const { video, created } = await insertVideo(env.DB, { kind, reportId, now: new Date().toISOString() });
  if (!created && video.status !== "queued") return;
  await queueJob(env, kind, reportId, video.id, scenes);
}

/** The owner's retry of a failed video: back to `queued` and a new job. False when there is no failed video (or nothing to show any more). */
export async function retryReportVideo(env: Env, kind: ReportKind, reportId: string): Promise<boolean> {
  const video = await getVideoFor(env.DB, kind, reportId);
  if (!video || !(await resetVideo(env.DB, video.id))) return false;
  const scenes = await scenesOf(env, kind, reportId);
  if (!scenes.length) {
    await failVideo(env.DB, video.id, "There is not enough in this report to make a video.");
    return false;
  }
  await queueJob(env, kind, reportId, video.id, scenes);
  return true;
}

/**
 * Puts a finished render on its video, if it is still wanted: the video is still `queued` (one that was discarded, or is already rendered, is left alone and nothing is written). The files must be exactly the two this
 * report's job lists and must have been uploaded; anything else is refused and the job stays claimed for the helper to try again.
 */
export async function applyReportVideo(env: Env, p: ReportRenderPayload, r: ReportRenderResult): Promise<void> {
  const video = await getVideo(env.DB, p.videoId);
  if (!video || video.status !== "queued") return;
  const k = reportVideoKeys(video.reportKind, video.reportId);
  if (p.outputs[0] !== k.mp4 || p.outputs[1] !== k.jpg) throw new HelperRefused(`this job does not belong to the video of that report: its files are ${k.mp4} and ${k.jpg}`);
  if (r.videoKey !== k.mp4 || r.posterKey !== k.jpg) throw new HelperRefused(`those are not this job's outputs: the video goes to ${k.mp4} and the poster to ${k.jpg}`);
  for (const key of [k.mp4, k.jpg]) {
    if (!(await env.RAW.head(key))) throw new HelperRefused(`the file was never uploaded to ${key}`);
  }
  await finishVideo(env.DB, video.id, { videoKey: k.mp4, posterKey: k.jpg, durationMs: Math.round(r.durationMs) });
}

/** The job could not be done (the helper gave it up, or nobody picked it up in time): the video says so in a plain sentence. A video that is no longer `queued` is left as it is. */
export async function failReportVideo(env: Env, videoId: string, why: string): Promise<void> {
  await failVideo(env.DB, videoId, why);
}
