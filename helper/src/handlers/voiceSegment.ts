import type { JobHandler } from "../loop.ts";
import type { Media } from "../ffmpeg.ts";
import type { EngineId, VoiceEngine } from "../voice/engine.ts";
import { cloneAndUpload, engineField, payloadOf, textField } from "./clone.ts";

export const VOICE_SEGMENT_KIND = "voice.segment";

/**
 * `voice.segment`: one script line in the cloned voice. Payload `{ videoId, segmentId, engine, text, refKey? }`; result `{ key, durationMs }`
 * where `key` is the job's single output (`video/<videoId>/audio/<segmentId>-<hash>.wav`, named by the server). Recorded lines are not jobs.
 */
export function voiceSegmentHandler(engines: Record<EngineId, VoiceEngine>, media: Media): JobHandler {
  return {
    kind: VOICE_SEGMENT_KIND,
    async run(ctx) {
      const p = payloadOf(ctx.job);
      textField(p, "videoId"); textField(p, "segmentId");
      const engine = engines[engineField(p)];
      return cloneAndUpload(ctx, { engine, text: textField(p, "text"), media });
    },
  };
}
