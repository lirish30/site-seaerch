import type { Env } from "../env";
import { getVideoAudit, moveVideoStatus } from "../db/videoAudits";
import { enqueueHelperJob } from "../helper/jobs";
import { VOICE_SEGMENT_KIND, type VoiceEngine } from "../helper/kinds";
import { hashText, lineStale, type Segment } from "./plan";

/**
 * Queues the render once every line of the video has its audio. Task 9 implements it (the `render` helper job); until then it does nothing.
 * Callers go through `productionDeps.enqueueRender`, so a test can replace it with a spy.
 */
export async function enqueueRender(_env: Env, _videoId: string): Promise<void> {}

/** The one seam tests replace: what finishing the last line of a video does. */
export const productionDeps = { enqueueRender };

/** True when every line has audio that matches its current words (a clone or a recording alike). */
export const allVoiced = (segments: Segment[]): boolean => segments.length > 0 && segments.every((s) => !!s.audio && s.audio.textHash === hashText(s.text));

/** The engine that clones the voice. Task 6 reads `settings.voice_engine` here; until it exists there is one fixed choice. */
function voiceEngine(_env: Env): VoiceEngine { return "qwen3-tts"; }

/**
 * Starts making the video from an approved plan: moves it to `producing`, then queues the cloned voice for every line that has no audio for its
 * current words (one `voice.segment` job per line, keyed by video, line and words, so a second call queues nothing new). A line with a recording
 * of its current words is left as it is. When there is no voice work to wait for, the render is queued straight away.
 * Returns whether this call started it: a video that is not in review (already started, cancelled, moved on) is left alone, so a double approve starts it once.
 */
export async function startProduction(env: Env, videoId: string): Promise<boolean> {
  if (!(await moveVideoStatus(env.DB, videoId, ["review"], "producing", { error: null }))) return false;
  const plan = (await getVideoAudit(env.DB, videoId))?.plan;
  if (!plan) return true;
  const engine = voiceEngine(env);
  const stale = plan.segments.filter(lineStale);
  for (const s of stale) {
    await enqueueHelperJob(env.DB, VOICE_SEGMENT_KIND, { videoId, segmentId: s.id, engine, text: s.text }, { videoId, dedupeKey: `${videoId}:${s.id}:${hashText(s.text)}` });
  }
  if (stale.length === 0 && allVoiced(plan.segments)) await productionDeps.enqueueRender(env, videoId);
  return true;
}
