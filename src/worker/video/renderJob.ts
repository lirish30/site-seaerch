import type { Env } from "../env";
import { createPublishApproval } from "../approvals/videoPublish";
import { finishRender, getVideoAudit } from "../db/videoAudits";
import { getSettings } from "../db/settings";
import { enqueueHelperJob } from "../helper/jobs";
import { HelperRefused, RENDER_KIND, renderKeys, type RenderPayload, type RenderResult } from "../helper/kinds";
import { allVoiced } from "./production";

export { RENDER_KIND, renderKeys, type RenderPayload, type RenderResult };

/** "https://hellositeline.com/book/" as "hellositeline.com/book": what a person can read off a video and type. Empty for anything but an https address. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:") return "";
    return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
}

/**
 * Queues the render once every line of the video has audio for its current words. Does nothing for a video that is not being made (no longer
 * `producing`), has no plan, or has a line still waiting for its voice. One job per video and plan version (the dedupe key), so the last two lines
 * finishing at the same moment, or a crashed `apply` that runs again, queue one render and not two. The job carries the plan, who the end card
 * is from, the call to action and the files the helper may read; the worker, not the helper, says what they are.
 */
export async function enqueueRender(env: Env, videoId: string): Promise<void> {
  const video = await getVideoAudit(env.DB, videoId);
  const plan = video?.plan;
  if (!video || video.status !== "producing" || !plan || !allVoiced(plan.segments)) return;
  const settings = await getSettings(env.DB);
  const link = displayUrl(settings.booking_url);
  const payload: RenderPayload = {
    videoId, planVersion: plan.version,
    plan: { shots: plan.shots, segments: plan.segments },
    brand: { name: settings.your_name.trim() || settings.business_name.trim() || "Siteline", business: settings.business_name.trim() || settings.your_name.trim() || "Siteline" },
    ctaText: link ? `Book a call: ${link}` : settings.contact_email.trim() ? `Reply to ${settings.contact_email.trim()} to book a call` : "Reply to this email to book a call",
    inputs: [...new Set([...plan.shots.map((s) => s.fullKey), ...plan.segments.flatMap((s) => (s.audio ? [s.audio.key] : []))])],
  };
  await enqueueHelperJob(env.DB, RENDER_KIND, payload, { videoId, dedupeKey: `${videoId}:${plan.version}` });
}

/**
 * Puts a finished render on its video, if it is still wanted: the video is still `producing` and its plan is still at the version the job was made for.
 * Anything else (an edit, a cancel, a newer plan) discards it and writes nothing, and above all makes no approval. Then the files are stored, the video
 * is `rendered` and its publish approval is made. Crash-safe: a retry after `rendered` was written finds the video rendered from this very render and
 * only makes the approval if it is still missing.
 */
export async function applyRender(env: Env, p: RenderPayload, r: RenderResult): Promise<void> {
  const video = await getVideoAudit(env.DB, p.videoId);
  if (!video?.plan) return;
  const k = renderKeys(p.videoId, p.planVersion);
  const rendered = video.status === "rendered" && video.plan.version === p.planVersion && video.video_key === k.mp4;
  if (rendered) {
    if (!video.publish_approval_id) await createPublishApproval(env, p.videoId);
    return;
  }
  if (video.status !== "producing" || video.plan.version !== p.planVersion) return;

  if (r.videoKey !== k.mp4 || r.gifKey !== k.gif || r.posterKey !== k.jpg) {
    throw new HelperRefused(`those are not this job's outputs: the video goes to ${k.mp4}, the preview to ${k.gif} and the poster to ${k.jpg}`);
  }
  for (const key of [k.mp4, k.gif, k.jpg]) {
    if (!(await env.RAW.head(key))) throw new HelperRefused(`the file was never uploaded to ${key}`);
  }
  const moved = await finishRender(env.DB, p.videoId, p.planVersion, { video_key: k.mp4, gif_key: k.gif, poster_key: k.jpg, duration_ms: Math.round(r.durationMs) });
  if (!moved) return; // an edit or a cancel got there first
  await createPublishApproval(env, p.videoId);
}
