import type { Env } from "../env";
import { getSettings } from "../db/settings";
import { getVideoAudit, moveVideoStatus } from "../db/videoAudits";
import { enqueueHelperJob } from "../helper/jobs";
import { VOICE_SEGMENT_KIND, type VoiceEngine } from "../helper/kinds";
import type { Settings } from "../types";
import { hashText, lineStale, type Segment, type VideoPlan } from "./plan";
import { enqueueRender } from "./renderJob";

export { enqueueRender };

/** The one seam tests replace: what finishing the last line of a video does (`enqueueRender` queues the render, see renderJob.ts). */
export const productionDeps = { enqueueRender };

/** True when every line has audio that matches its current words (a clone or a recording alike). */
export const allVoiced = (segments: Segment[]): boolean => segments.length > 0 && segments.every((s) => !!s.audio && s.audio.textHash === hashText(s.text));

/** Said when a video wants the cloned voice and none is set up. Approving lists it as a blocker. */
export const PICK_A_VOICE = "Pick a voice first (Settings > Voice test), or record your own lines.";

/** The cloned voice the owner set up: the engine they picked in the voice test and their reference recording. Null until both exist. */
export function voiceOf(s: Pick<Settings, "voice_engine" | "voice_ref_key">): { engine: VoiceEngine; refKey: string } | null {
  return s.voice_engine && s.voice_ref_key ? { engine: s.voice_engine, refKey: s.voice_ref_key } : null;
}

/** What stops a plan from being approved because of the voice: a cloned narration with no cloned voice to speak it. */
export const voiceBlockers = (plan: Pick<VideoPlan, "narration">, s: Pick<Settings, "voice_engine" | "voice_ref_key">): string[] =>
  plan.narration === "clone" && !voiceOf(s) ? [PICK_A_VOICE] : [];

/**
 * Starts making the video from an approved plan: moves it to `producing`, then queues the cloned voice for every line that has no audio for its
 * current words (one `voice.segment` job per line, keyed by video, line and words, so a second call queues nothing new). A line with a recording
 * of its current words is left as it is. When there is no voice work to wait for, the render is queued straight away.
 * Returns whether this call started it: a video that is not in review (already started, cancelled, moved on) is left alone, so a double approve starts it once.
 * A video that turns out to have lines to voice and no voice to do it goes back to review with PICK_A_VOICE as its error, and this returns false.
 */
export async function startProduction(env: Env, videoId: string): Promise<boolean> {
  const settings = await getSettings(env.DB);
  const voice = voiceOf(settings);
  // A cloned video with no voice to clone is not started: it stays in review so the owner can pick one (the approve route lists the same blocker).
  const before = await getVideoAudit(env.DB, videoId);
  if (before?.status === "review" && before.plan && voiceBlockers(before.plan, settings).length) return false;
  if (!(await moveVideoStatus(env.DB, videoId, ["review"], "producing", { error: null }))) return false;
  const plan = (await getVideoAudit(env.DB, videoId))?.plan;
  if (!plan) return true;
  const stale = plan.segments.filter(lineStale);
  if (stale.length && !voice) {
    // Not a failed video: its plan and recordings are fine, it only needs a voice. Back to review, saying so.
    await moveVideoStatus(env.DB, videoId, ["producing"], "review", { error: PICK_A_VOICE });
    return false;
  }
  for (const s of stale) {
    await enqueueHelperJob(env.DB, VOICE_SEGMENT_KIND, { videoId, segmentId: s.id, engine: voice!.engine, text: s.text, refKey: voice!.refKey }, { videoId, dedupeKey: `${videoId}:${s.id}:${hashText(s.text)}` });
  }
  if (stale.length === 0 && allVoiced(plan.segments)) await productionDeps.enqueueRender(env, videoId);
  return true;
}
