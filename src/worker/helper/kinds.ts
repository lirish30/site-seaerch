import { z } from "zod";
import type { Env } from "../env";
import { getVideoAudit, moveVideoStatus, setSegmentAudio } from "../db/videoAudits";
import { ShotSchema, SegmentSchema, hashText } from "../video/plan";
import { allVoiced, productionDeps } from "../video/production";
import { applyRender } from "../video/renderJob";
import { applyReportVideo, failReportVideo } from "../report/videoJob";
import { MAX_SCENES, SceneSchema } from "../report/videoScenes";
import type { ReportKind } from "../db/reportVideos";
import { cancelHelperJobsFor } from "./jobs";
import { HelperRefused, registerHelperKind, type HelperKindDef } from "./registry";

/** The registry lives in `registry.ts` so a kind in another folder can register itself without importing this file (which would make a cycle); everything is re-exported here. */
export { HelperRefused, getHelperKind, registerHelperKind, registeredHelperKinds, unregisterHelperKind, type HelperKindDef } from "./registry";

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

/**
 * A video that cannot be made right now (a voice engine is not installed, `hyperframes` is not on the helper's PATH, the Mac was off): it goes back to
 * `review` with the reason in `error`, unless it has moved on meanwhile (the move is compare-and-set), and its other helper jobs are closed. The plan
 * and the audio already made are kept, so approving again queues only what is missing: a closed job is not "open", so its dedupe key is free.
 */
export async function failProducing(env: Env, videoId: string, why: string): Promise<void> {
  await moveVideoStatus(env.DB, videoId, ["producing"], "review", { error: why });
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
    // A retry of a crashed apply finds this very audio already on the line: it is not written again (that would bump the plan's version, and a render queued
    // for the old version would be thrown away), but the render is still queued, in case the crash came before it.
    const already = seg.audio?.key === r.key && seg.audio.textHash === hashText(p.text);
    const written = already || (await setSegmentAudio(env.DB, p.videoId, p.segmentId, p.text, { key: r.key, source: "clone", durationMs: Math.round(r.durationMs), textHash: hashText(p.text) }));
    if (!written) return;
    const now = await getVideoAudit(env.DB, p.videoId);
    if (now?.status === "producing" && now.plan && allVoiced(now.plan.segments)) await productionDeps.enqueueRender(env, p.videoId);
  },

  async onFail(env, p, error) { await failProducing(env, p.videoId, `The voice for a line could not be made: ${error}`); },
  async onExpire(env, p) { await failProducing(env, p.videoId, "Your Mac helper didn't pick up the voice work in time. Approve the video again when it is running."); },
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

/** The finished video: the MP4, a short preview GIF and a poster image, made from a video's plan, its screenshots and the audio of every line. */
export const RENDER_KIND = "render";

export const RenderPayload = z.object({
  videoId: z.string().min(1),
  /** The plan's version when the job was made. A result for any other version is thrown away. */
  planVersion: z.number().int().nonnegative(),
  plan: z.object({ shots: z.array(ShotSchema), segments: z.array(SegmentSchema) }),
  /** The end card: whose video this is (`name` is the person, `business` their business). */
  brand: z.object({ name: z.string(), business: z.string() }),
  ctaText: z.string(),
  /** Every R2 key the helper may read: each shot's full image and each line's audio. */
  inputs: z.array(z.string().min(1)),
});
export type RenderPayload = z.infer<typeof RenderPayload>;
export const RenderResult = z.object({
  videoKey: z.string().min(1), gifKey: z.string().min(1), posterKey: z.string().min(1),
  durationMs: z.number().nonnegative(), bytes: z.number().nonnegative(),
});
export type RenderResult = z.infer<typeof RenderResult>;

/** Where a render's three files go. The plan's version is in the name, so the files of an older plan can never pass for the current one's. */
export const renderKeys = (videoId: string, planVersion: number): { mp4: string; gif: string; jpg: string } => ({
  mp4: `video/${videoId}/out/v${planVersion}.mp4`, gif: `video/${videoId}/out/v${planVersion}.gif`, jpg: `video/${videoId}/out/v${planVersion}.jpg`,
});

const render: HelperKindDef<RenderPayload, RenderResult> = {
  kind: RENDER_KIND,
  payload: RenderPayload,
  result: RenderResult,
  inputs: (p) => [...new Set(p.inputs)],
  outputs: (p) => { const k = renderKeys(p.videoId, p.planVersion); return [k.mp4, k.gif, k.jpg]; },
  apply: (env, p, r) => applyRender(env, p, r),
  async onFail(env, p, error) { await failProducing(env, p.videoId, `The video could not be rendered: ${error}`); },
  async onExpire(env, p) { await failProducing(env, p.videoId, "Your Mac helper didn't pick up the render in time. Approve the video again when it is running."); },
};
registerHelperKind(render);
import "../meetings/syncKind"; // registers meetily.sync; a kind that lives beside its own code, as queue/kinds.ts does for task kinds
import "../care/inventoryKind"; // registers care.inventory
import "../care/updateKind"; // registers care.update
import "../care/certsKind"; // registers care.certs

/** The short, silent video that goes with a Care or Local SEO report: an MP4 and its poster, made from scenes of the report's own numbers. It reads nothing from the files bucket. */
export const REPORT_RENDER_KIND = "report.render";

/** Where a report's video and poster go. Fixed by the report, never by the helper. */
export const reportVideoKeys = (kind: ReportKind, reportId: string): { mp4: string; jpg: string } => ({
  mp4: `report-video/${kind}/${reportId}/v1.mp4`, jpg: `report-video/${kind}/${reportId}/v1.jpg`,
});

export const ReportRenderPayload = z.object({
  videoId: z.string().min(1),
  scenes: z.array(SceneSchema).min(1).max(MAX_SCENES),
  brand: z.object({ name: z.string().max(80) }),
  /** The video, then its poster. */
  outputs: z.tuple([z.string().regex(/^report-video\/(care|seo)\/[A-Za-z0-9_-]{1,100}\/v1\.mp4$/), z.string().regex(/^report-video\/(care|seo)\/[A-Za-z0-9_-]{1,100}\/v1\.jpg$/)]),
});
export type ReportRenderPayload = z.infer<typeof ReportRenderPayload>;
export const ReportRenderResult = z.object({ videoKey: z.string().min(1), posterKey: z.string().min(1), durationMs: z.number().nonnegative() });
export type ReportRenderResult = z.infer<typeof ReportRenderResult>;

const reportRender: HelperKindDef<ReportRenderPayload, ReportRenderResult> = {
  kind: REPORT_RENDER_KIND,
  payload: ReportRenderPayload,
  result: ReportRenderResult,
  inputs: () => [],
  outputs: (p) => [...p.outputs],
  apply: (env, p, r) => applyReportVideo(env, p, r),
  async onFail(env, p) { await failReportVideo(env, p.videoId, "The report video could not be made. The report itself is not affected."); },
  async onExpire(env, p) { await failReportVideo(env, p.videoId, "Your Mac helper didn't pick up the report video in time."); },
};
registerHelperKind(reportRender);
