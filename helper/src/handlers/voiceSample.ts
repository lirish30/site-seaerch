import type { JobHandler } from "../loop.ts";
import type { Media } from "../ffmpeg.ts";
import type { EngineId, VoiceEngine } from "../voice/engine.ts";
import { cloneAndUpload, engineField, payloadOf, textField } from "./clone.ts";

export const VOICE_SAMPLE_KIND = "voice.sample";

/**
 * `voice.sample`: one clip of the blind voice test. Payload `{ testId, engine, line, refKey }`; result `{ durationMs }`. The clip goes to the job's
 * single output (`voice-tests/<testId>/<engine>.wav`). Every engine of a test gets the same line and the same reference, so the clips differ only in engine.
 */
export function voiceSampleHandler(engines: Record<EngineId, VoiceEngine>, media: Media): JobHandler {
  return {
    kind: VOICE_SAMPLE_KIND,
    async run(ctx) {
      const p = payloadOf(ctx.job);
      textField(p, "testId");
      const engine = engines[engineField(p)];
      const { durationMs } = await cloneAndUpload(ctx, { engine, text: textField(p, "line"), media });
      return { durationMs };
    },
  };
}
