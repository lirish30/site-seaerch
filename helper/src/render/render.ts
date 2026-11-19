import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { runProcess, type Exec } from "../exec.ts";
import { probeDurationMs } from "../ffmpeg.ts";

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 30;
/** The server takes an upload of up to 80 MB; a video this size or smaller plays on a phone without trouble. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
/** What the retry aims for: a little under the limit, because a bitrate is a target the encoder only roughly meets. */
const RETRY_TARGET_BYTES = 34 * 1024 * 1024;
/** HyperFrames encodes the audio at about this (AAC, 192 kbit/s). */
const AUDIO_KBPS = 192;
const MIN_VIDEO_KBPS = 300;
/** A 130 second video takes a few minutes; this is only here so a render stuck for good ends. */
const RENDER_TIMEOUT_MS = 45 * 60_000;
const REMUX_TIMEOUT_MS = 5 * 60_000;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * THE one place the HyperFrames command line is written (checked against hyperframes 0.9.69: `hyperframes render <dir> -o <file> --fps 30`).
 * The frame size comes from the page (`data-width` / `data-height`), the codecs are H.264 and AAC in an MP4 by default. If a newer version changes
 * a flag, this is the only line to fix. `kbps`, when given, asks for that video bitrate (the retry of a file that came out too big).
 */
export function hyperframesArgs(projectDir: string, outFile: string, kbps?: number): string[] {
  return ["render", projectDir, "-o", outFile, "--fps", String(FPS), "--quiet", ...(kbps ? ["--video-bitrate", `${kbps}k`] : [])];
}

/** Runs HyperFrames on a project. Its telemetry is switched off (it would report that a render happened), and it is told nothing about the lead. */
export async function runHyperframes(cfg: Pick<Config, "hyperframes">, args: string[], exec: Exec = runProcess): Promise<void> {
  await exec(cfg.hyperframes, args, { timeoutMs: RENDER_TIMEOUT_MS, env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" } });
}

/** The video bitrate (kbit/s) that should bring a video of this length to about 34 MB, audio included. A longer video gets a lower one. */
export function retryBitrateKbps(seconds: number): number {
  const total = (RETRY_TARGET_BYTES * 8) / Math.max(1, seconds) / 1000;
  return Math.max(MIN_VIDEO_KBPS, Math.floor(total - AUDIO_KBPS));
}

export interface RenderOptions {
  /** The project's text files by path (`composition.ts` makes them). Its pictures and audio must already be in `workDir/assets`. */
  files: Record<string, string>;
  /** The project folder. */
  workDir: string;
  cfg: Pick<Config, "hyperframes" | "ffmpeg" | "ffprobe">;
  /** For tests. */
  exec?: Exec;
}

/**
 * Writes the project, has HyperFrames render it (1280x720, 30 fps, H.264 and AAC), moves the file's index to the front (`+faststart`, so it plays
 * before it has all arrived) and checks its size. A file over 40 MB is rendered once more at a bitrate worked out from its length; one still over
 * after that fails with its size. Returns the finished file and its length as measured by ffprobe.
 */
export async function renderVideo(o: RenderOptions): Promise<{ mp4: string; durationMs: number }> {
  const exec = o.exec ?? runProcess;
  for (const [path, text] of Object.entries(o.files)) {
    const to = join(o.workDir, path);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, text);
  }
  const outDir = join(o.workDir, "renders");
  await mkdir(outDir, { recursive: true });
  const raw = join(outDir, "raw.mp4");
  const mp4 = join(outDir, "video.mp4");

  let kbps: number | undefined;
  for (let attempt = 1; ; attempt++) {
    await runHyperframes(o.cfg, hyperframesArgs(o.workDir, raw, kbps), exec);
    await exec(o.cfg.ffmpeg, ["-y", "-v", "error", "-i", raw, "-c", "copy", "-movflags", "+faststart", mp4], { timeoutMs: REMUX_TIMEOUT_MS });
    await rm(raw, { force: true });
    const size = (await stat(mp4)).size;
    const durationMs = await probeDurationMs(mp4, o.cfg, exec);
    if (size <= MAX_VIDEO_BYTES) return { mp4, durationMs };
    if (attempt >= 2) throw new Error(`The video is ${mb(size)}, over the ${MAX_VIDEO_BYTES / 1024 / 1024} MB limit even at a lower bitrate.`);
    kbps = retryBitrateKbps(durationMs / 1000);
  }
}
