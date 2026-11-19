import { runProcess, type Exec } from "./exec.ts";
import type { Config } from "./config.ts";

const TIMEOUT_MS = 5 * 60_000;

/** The media steps a handler needs, so a test can stand in for ffmpeg. */
export interface Media {
  /** Mono 24 kHz 16-bit PCM wav, loudness-normalised: the form every narration clip is stored and rendered in. */
  toWav(inFile: string, outFile: string): Promise<void>;
  /** Mono 24 kHz wav with the loudness left alone: what a voice engine is given to clone. */
  toRefWav(inFile: string, outFile: string): Promise<void>;
  probeDurationMs(file: string): Promise<number>;
}

/**
 * Reads the length of a file from `ffprobe -print_format json -show_format -show_streams` output, as whole milliseconds. The container's duration
 * wins; a file whose container does not say (a bare webm stream) falls back to its first audio stream's.
 */
export function parseProbe(json: string): number {
  let o: { format?: { duration?: unknown }; streams?: { duration?: unknown }[] };
  try { o = JSON.parse(json); } catch { throw new Error("ffprobe did not print JSON"); }
  const candidates = [o?.format?.duration, ...(o?.streams ?? []).map((s) => s?.duration)];
  for (const c of candidates) {
    const seconds = typeof c === "string" || typeof c === "number" ? Number(c) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  throw new Error("ffprobe reported no duration for this file");
}

export async function probeDurationMs(file: string, cfg: Pick<Config, "ffprobe">, exec: Exec = runProcess): Promise<number> {
  const { stdout } = await exec(cfg.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  return parseProbe(stdout);
}

/** Loudness target for narration: -16 LUFS integrated, the usual level for spoken web video. */
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

export async function toWav(inFile: string, outFile: string, cfg: Pick<Config, "ffmpeg">, exec: Exec = runProcess): Promise<void> {
  await exec(cfg.ffmpeg, ["-y", "-v", "error", "-i", inFile, "-vn", "-af", LOUDNORM, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outFile], { timeoutMs: TIMEOUT_MS });
}

export async function toRefWav(inFile: string, outFile: string, cfg: Pick<Config, "ffmpeg">, exec: Exec = runProcess): Promise<void> {
  await exec(cfg.ffmpeg, ["-y", "-v", "error", "-i", inFile, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outFile], { timeoutMs: TIMEOUT_MS });
}

/** The real ffmpeg and ffprobe, as the config names them. */
export const realMedia = (cfg: Pick<Config, "ffmpeg" | "ffprobe">): Media => ({
  toWav: (i, o) => toWav(i, o, cfg),
  toRefWav: (i, o) => toRefWav(i, o, cfg),
  probeDurationMs: (f) => probeDurationMs(f, cfg),
});
