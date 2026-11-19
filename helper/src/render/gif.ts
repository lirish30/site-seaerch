import type { Config } from "../config.ts";
import { runProcess, type Exec } from "../exec.ts";
import { stat } from "node:fs/promises";

export const MAX_GIF_BYTES = 1.5 * 1024 * 1024;
export const GIF_WIDTH = 480;
export const GIF_SECONDS = 6;
const TIMEOUT_MS = 5 * 60_000;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Each try is lighter than the one before: fewer colours, then fewer frames. The first is the normal look (480 px wide, 8 frames a second). */
const LADDER = [
  { fps: 8, colors: 256, dither: "sierra2_4a" },
  { fps: 8, colors: 128, dither: "bayer:bayer_scale=3" },
  { fps: 6, colors: 64, dither: "bayer:bayer_scale=3" },
  { fps: 5, colors: 32, dither: "bayer:bayer_scale=4" },
] as const;

export interface GifOptions {
  mp4: string;
  outPath: string;
  /** How much of the video to take, from `startSeconds`. The first 6 seconds of the hook scene at most. */
  seconds: number;
  startSeconds?: number;
  cfg: Pick<Config, "ffmpeg">;
  exec?: Exec;
}

/**
 * The animated preview: `seconds` of the video (6 at most) as a 480 px wide GIF at 8 frames a second, with a colour palette made for those frames
 * (`palettegen` then `paletteuse`, far better than the default palette). A GIF over 1.5 MB is made again lighter, up to four tries; one still too big fails with its size.
 */
export async function makeGif(o: GifOptions): Promise<{ bytes: number }> {
  const exec = o.exec ?? runProcess;
  const seconds = Math.min(GIF_SECONDS, o.seconds);
  let bytes = 0;
  for (const step of LADDER) {
    const filter = `fps=${step.fps},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${step.dither}`;
    await exec(o.cfg.ffmpeg, ["-y", "-v", "error", ...(o.startSeconds ? ["-ss", String(o.startSeconds)] : []), "-t", String(seconds), "-i", o.mp4, "-vf", filter, "-loop", "0", o.outPath], { timeoutMs: TIMEOUT_MS });
    bytes = (await stat(o.outPath)).size;
    if (bytes <= MAX_GIF_BYTES) return { bytes };
  }
  throw new Error(`The preview GIF is ${mb(bytes)}, over the ${mb(MAX_GIF_BYTES)} limit even with fewer colours and frames.`);
}

/** One frame of the video as a JPEG, `atSeconds` in (2 seconds, unless the video is shorter). */
export async function makePoster(o: { mp4: string; outPath: string; atSeconds: number; cfg: Pick<Config, "ffmpeg">; exec?: Exec }): Promise<void> {
  const exec = o.exec ?? runProcess;
  await exec(o.cfg.ffmpeg, ["-y", "-v", "error", "-ss", String(o.atSeconds), "-i", o.mp4, "-frames:v", "1", "-q:v", "3", o.outPath], { timeoutMs: TIMEOUT_MS });
}
