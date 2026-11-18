import { z } from "zod";
import type { Env } from "../env";
import { getVideoAudit, setSegmentAudio, setVideoStatus } from "../db/videoAudits";
import { hashText } from "../video/plan";
import { allVoiced, productionDeps } from "../video/production";
import { cancelHelperJobsFor } from "./jobs";

/**
 * One kind of work the Mac helper does. The queue knows nothing about a kind beyond this: `payload` and `result` are its two contracts, and
 * `apply` is the only code that ever acts on what the helper sent back.
 *
 *  - `inputs` and `outputs` are R2 keys, computed here by the worker and never by the helper: the helper may read only a key in `inputs` and write
 *    only a key in `outputs` (exact keys, no patterns).
 *  - `apply` runs once per job, under a lease (see `completeHelperJob`). It must tolerate a crash-retry. A result that no longer fits its target
 *    (the line was edited, the video moved on) is discarded: return normally and write nothing. Throw `HelperRefused` to refuse the result:
 *    the helper is told why and the job stays claimed so it can try again.
 *  - `onFail` runs once for a job that ended `failed` (the helper gave it up, or it was claimed `MAX_ATTEMPTS` times and never completed), and
 *    `onExpire` for one nobody picked up in time: both best effort, after the status write.
 */
export interface HelperKindDef<P, R> {
  kind: string;
  payload: z.ZodType<P>;
  result: z.ZodType<R>;
  inputs(p: P): string[];
  outputs(p: P): string[];
  apply(env: Env, p: P, r: R): Promise<void>;
  onFail?(env: Env, p: P, error: string): Promise<void>;
  onExpire?(env: Env, p: P): Promise<void>;
}

/** Thrown from `apply` to refuse the result: `completeHelperJob` returns the message and the job stays claimed. */
export class HelperRefused extends Error {}

const kinds = new Map<string, HelperKindDef<any, any>>();

/** Idempotent by kind: registering a kind again replaces it, so re-imports never throw. */
export function registerHelperKind<P, R>(def: HelperKindDef<P, R>): void { kinds.set(def.kind, def); }
/** For tests, which register their own kinds and must leave the registry as they found it. */
export function unregisterHelperKind(kind: string): void { kinds.delete(kind); }
export const getHelperKind = (kind: string): HelperKindDef<any, any> | undefined => kinds.get(kind);
export const registeredHelperKinds = (): string[] => [...kinds.keys()];

export const VOICE_ENGINES = ["qwen3-tts", "chatterbox", "openvoice-v2"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

/** The cloned voice for one line of a video. */
export const VOICE_SEGMENT_KIND = "voice.segment";

export const VoiceSegmentPayload = z.object({
  videoId: z.string().min(1),
  segmentId: z.string().min(1),
  engine: z.enum(VOICE_ENGINES),
  text: z.string().min(1),
  /** The reference recording to clone (`settings.voice_ref_key`). Optional in the schema so a job queued before it existed still parses; `startProduction` always sets it. */
  refKey: z.string().min(1).optional(),
});
export type VoiceSegmentPayload = z.infer<typeof VoiceSegmentPayload>;
export const VoiceSegmentResult = z.object({ key: z.string().min(1), durationMs: z.number().nonnegative() });
export type VoiceSegmentResult = z.infer<typeof VoiceSegmentResult>;

/** Where a line's cloned audio goes. The words are in the name, so a take of old words can never pass for the line's current ones. */
export const voiceSegmentKey = (p: Pick<VoiceSegmentPayload, "videoId" | "segmentId" | "text">): string => `video/${p.videoId}/audio/${p.segmentId}-${hashText(p.text)}.wav`;

/** A video that cannot be made any further: it fails with the reason, unless it has moved on meanwhile, and its other helper jobs are closed. */
async function failProducing(env: Env, videoId: string, why: string): Promise<void> {
  const v = await getVideoAudit(env.DB, videoId);
  if (v?.status === "producing") await setVideoStatus(env.DB, videoId, "failed", { error: why });
  await cancelHelperJobsFor(env.DB, videoId);
}

const voiceSegment: HelperKindDef<VoiceSegmentPayload, VoiceSegmentResult> = {
  kind: VOICE_SEGMENT_KIND,
  payload: VoiceSegmentPayload,
  result: VoiceSegmentResult,
  // The helper may read the reference recording and nothing else. A job queued before the reference existed has none.
  inputs: (p) => (p.refKey ? [p.refKey] : []),
  outputs: (p) => [voiceSegmentKey(p)],

  /**
   * Puts the audio on its line, if the line is still what the job was made for: the video is still `producing`, the line still exists and its words
   * are exactly the payload's. Anything else (an edit, a cancel) discards the result. Written in one guarded statement, so two lines finishing at the
   * same moment cannot overwrite each other. The last line to get its audio queues the render.
   */
  async apply(env, p, r) {
    const expected = voiceSegmentKey(p);
    const video = await getVideoAudit(env.DB, p.videoId);
    const seg = video?.plan?.segments.find((s) => s.id === p.segmentId);
    if (!video || video.status !== "producing" || !seg || seg.text !== p.text) return;
    if (r.key !== expected) throw new HelperRefused(`that is not this job's output: the voice goes to ${expected}`);
    if (!(await env.RAW.head(expected))) throw new HelperRefused(`the voice file was never uploaded to ${expected}`);
    const written = await setSegmentAudio(env.DB, p.videoId, p.segmentId, p.text, { key: r.key, source: "clone", durationMs: Math.round(r.durationMs), textHash: hashText(p.text) });
    if (!written) return;
    const now = await getVideoAudit(env.DB, p.videoId);
    if (now?.status === "producing" && now.plan && allVoiced(now.plan.segments)) await productionDeps.enqueueRender(env, p.videoId);
  },

  async onFail(env, p, error) { await failProducing(env, p.videoId, `The voice for a line could not be made: ${error}`); },
  async onExpire(env, p) { await failProducing(env, p.videoId, "Your Mac helper didn't pick up the voice work in time. Start the video again when it is running."); },
};
registerHelperKind(voiceSegment);

/** One clip of the blind voice test: a line read by one engine in the owner's cloned voice. Not tied to a video. */
export const VOICE_SAMPLE_KIND = "voice.sample";

export const VoiceSamplePayload = z.object({
  testId: z.string().min(1),
  engine: z.enum(VOICE_ENGINES),
  line: z.string().min(1),
  refKey: z.string().min(1),
});
export type VoiceSamplePayload = z.infer<typeof VoiceSamplePayload>;
export const VoiceSampleResult = z.object({ durationMs: z.number().nonnegative() });
export type VoiceSampleResult = z.infer<typeof VoiceSampleResult>;

/** Where a test's clip goes. The page serves it by label, so the engine's name is in the key only, never in a URL. */
export const voiceSampleKey = (p: Pick<VoiceSamplePayload, "testId" | "engine">): string => `voice-tests/${p.testId}/${p.engine}.wav`;

const voiceSample: HelperKindDef<VoiceSamplePayload, VoiceSampleResult> = {
  kind: VOICE_SAMPLE_KIND,
  payload: VoiceSamplePayload,
  result: VoiceSampleResult,
  inputs: (p) => [p.refKey],
  outputs: (p) => [voiceSampleKey(p)],
  /** Nothing to put anywhere: the clip is the file the helper uploaded, and the test page finds it by its key. */
  async apply() {},
};
registerHelperKind(voiceSample);
