import { extname, join } from "node:path";
import type { JobContext } from "../loop.ts";
import type { Media } from "../ffmpeg.ts";
import { ENGINE_IDS, type EngineId, type VoiceEngine } from "../voice/engine.ts";

/** Reads `o[field]` as a non-empty string, or throws a message naming the field. */
export function textField(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || !v.trim()) throw new Error(`the job's ${field} is missing`);
  return v;
}

export function engineField(o: Record<string, unknown>): EngineId {
  const v = o.engine;
  if (typeof v !== "string" || !(ENGINE_IDS as readonly string[]).includes(v)) throw new Error(`the job's engine is not one this helper knows (${String(v)})`);
  return v as EngineId;
}

export function payloadOf(job: JobContext["job"]): Record<string, unknown> {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) throw new Error(`the ${job.kind} job has no payload`);
  return job.payload as Record<string, unknown>;
}

/**
 * The work both voice jobs share: fetch the one reference recording the job may read, have `engine` speak `text` in that voice, make it the
 * standard narration wav and upload it to the one output key the server listed. Returns the clip's length. The keys come from the job, never from here.
 */
export async function cloneAndUpload(
  { job, api, workDir }: Pick<JobContext, "job" | "api" | "workDir">,
  o: { engine: VoiceEngine; text: string; media: Media },
): Promise<{ key: string; durationMs: number }> {
  const [refKey, ...otherInputs] = job.inputs;
  if (!refKey || otherInputs.length) throw new Error("this job has no single reference recording to clone (set the voice reference in Settings first)");
  if (job.outputs.length !== 1) throw new Error(`this job should have one output file and has ${job.outputs.length}`);
  const outKey = job.outputs[0];

  const available = await o.engine.available();
  if (!available.ok) throw new Error(`${o.engine.id} is not available: ${available.why ?? "no reason given"}`);

  const refRaw = join(workDir, `reference${extname(refKey) || ".audio"}`);
  const refWav = join(workDir, "reference.wav");
  await api.download(job.id, refKey, refRaw);
  await o.media.toRefWav(refRaw, refWav);

  const raw = join(workDir, "speech-raw.wav");
  await o.engine.synth({ text: o.text, refAudioPath: refWav, outPath: raw });

  const out = join(workDir, "speech.wav");
  await o.media.toWav(raw, out);
  const durationMs = await o.media.probeDurationMs(out);
  if (!(durationMs > 0)) throw new Error(`${o.engine.id} made no audio (the clip is empty)`);

  await api.upload(job.id, outKey, out, "audio/wav");
  return { key: outKey, durationMs };
}
