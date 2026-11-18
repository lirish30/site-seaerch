import type { Env } from "../env";
import type { StepLike } from "../pipeline/lead";
import { getBusiness } from "../db/businesses";
import { getSettings } from "../db/settings";
import { recordUsage } from "../db/usage";
import { getVideoAudit, savePlan, setVideoStatus } from "../db/videoAudits";
import { PRICES } from "../cost";
import { defaultNarration, requestVideoScript } from "../queue/videoScript";
import { captureShots, type BrowserLike } from "./capture";

export interface VideoParams { videoId: string }
/** `browser` is for tests; without it the capture uses Browser Rendering. */
export interface VideoDeps { browser?: BrowserLike }

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/**
 * The workflow's part of a video: capture the shots of the lead's site and keep them in the plan, then queue the script for Claude and end.
 * A video that is not `capturing` any more (it was cancelled, or this run is a repeat) is left alone.
 */
export async function runVideoAudit(env: Env, step: StepLike, p: VideoParams, deps: VideoDeps = {}): Promise<void> {
  const video = await getVideoAudit(env.DB, p.videoId);
  if (!video) throw new Error(`Video ${p.videoId} not found`);
  if (video.status !== "capturing") return;
  const business = await getBusiness(env.DB, video.business_id);
  if (!business?.website_url?.trim()) throw new Error("This lead has no website to capture");
  const url = withScheme(business.website_url.trim());

  await step.do("capture", async () => {
    await setVideoStatus(env.DB, video.id, "capturing", { error: null });
    const shots = await captureShots(env, video.id, url, deps);
    await recordUsage(env.DB, "browser", 2, PRICES.browserPerRender * 2);
    await savePlan(env.DB, video.id, { shots, segments: [], narration: defaultNarration(await getSettings(env.DB)), version: 0 });
    return shots.map((s) => s.id);
  });

  await step.do("enqueue-script", async () => {
    // The status moves first: a script result is only accepted while the video is `scripting`. A repeat of this step finds it moved and queues nothing new (the task is deduplicated).
    const now = await getVideoAudit(env.DB, video.id);
    if (now?.status === "capturing") await setVideoStatus(env.DB, video.id, "scripting");
    if (now && (now.status === "capturing" || now.status === "scripting")) await requestVideoScript(env.DB, video.id, now.steering_note);
    return true;
  });
}

export async function runVideoWithErrorHandling(env: Env, step: StepLike, p: VideoParams, deps: VideoDeps = {}): Promise<void> {
  try {
    await runVideoAudit(env, step, p, deps);
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    await step.do("record-error", async () => {
      const v = await getVideoAudit(env.DB, p.videoId);
      if (v && (v.status === "capturing" || v.status === "scripting")) await setVideoStatus(env.DB, v.id, "failed", { error: message });
      return true;
    });
  }
}
