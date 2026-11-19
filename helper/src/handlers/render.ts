import { mkdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Exec } from "../exec.ts";
import type { Media } from "../ffmpeg.ts";
import type { JobHandler } from "../loop.ts";
import { GAP_MS, audioFile, buildComposition, shotFile, type Brand, type RenderPlan } from "../render/composition.ts";
import { makeGif, makePoster, GIF_SECONDS } from "../render/gif.ts";
import { renderVideo } from "../render/render.ts";
import { payloadOf, textField } from "./clone.ts";

export const RENDER_KIND = "render";

function objectField(o: Record<string, unknown>, field: string): Record<string, unknown> {
  const v = o[field];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`the job's ${field} is missing`);
  return v as Record<string, unknown>;
}

/** The job's output files, by what they are: the claim lists exactly three (an .mp4, a .gif and a .jpg) and the helper writes to those and no others. */
function outputsOf(outputs: string[]): { mp4: string; gif: string; jpg: string } {
  const by = (ext: string) => {
    const hit = outputs.filter((k) => k.toLowerCase().endsWith(ext));
    if (hit.length !== 1) throw new Error(`this job should list three output files (.mp4, .gif and .jpg) and ${hit.length ? "lists more than one" : "has no"} ${ext} file`);
    return hit[0];
  };
  return { mp4: by(".mp4"), gif: by(".gif"), jpg: by(".jpg") };
}

/**
 * `render`: the finished video. Payload `{ videoId, planVersion, plan: { shots, segments }, brand, ctaText, inputs }`; result
 * `{ videoKey, gifKey, posterKey, durationMs, bytes }`. Fetches every shot's picture and every line's audio (only keys the claim lists as inputs), turns
 * recorded lines into the standard wav, measures every line's audio (what is measured wins over what the plan stored), has HyperFrames render the
 * page `buildComposition` makes, makes the preview GIF and the poster, and uploads the three files to the job's three output keys. Nothing is uploaded
 * unless all three were made.
 */
export function renderHandler(media: Media, deps: { exec?: Exec } = {}): JobHandler {
  return {
    kind: RENDER_KIND,
    async run({ job, api, cfg, workDir }) {
      const p = payloadOf(job);
      textField(p, "videoId");
      const plan = objectField(p, "plan") as unknown as RenderPlan;
      if (!Array.isArray(plan.shots) || !Array.isArray(plan.segments)) throw new Error("the job's plan has no shots or lines");
      const brand = objectField(p, "brand") as unknown as Brand;
      const ctaText = typeof p.ctaText === "string" ? p.ctaText : "";
      const out = outputsOf(job.outputs);

      // Every file the plan needs must be one the server listed for this job: the helper reads nothing else.
      const allowed = new Set(job.inputs);
      const need = (key: string) => { if (!allowed.has(key)) throw new Error(`${key} is not one of this job's inputs`); return key; };
      for (const seg of plan.segments) {
        if (!seg.audio?.key) throw new Error(`Line ${seg.id} has no audio, so the video can't be put together yet.`);
        need(seg.audio.key);
      }
      for (const shot of plan.shots) need(shot.fullKey);

      const project = join(workDir, "project");
      const rawDir = join(workDir, "raw");
      await mkdir(join(project, "assets"), { recursive: true });
      await mkdir(rawDir, { recursive: true });

      for (const shot of plan.shots) await api.download(job.id, shot.fullKey, join(project, shotFile(shot)));

      const durationsMs: Record<string, number> = {};
      for (const seg of plan.segments) {
        const wav = join(project, audioFile(seg.id));
        if (seg.audio!.source === "recorded") {
          // The browser's recording (webm, or a wav of any level) becomes the same mono 24 kHz, loudness-matched wav the cloned lines are.
          const raw = join(rawDir, `line-${seg.id}${extname(seg.audio!.key) || ".audio"}`);
          await api.download(job.id, seg.audio!.key, raw);
          await media.toWav(raw, wav);
        } else {
          await api.download(job.id, seg.audio!.key, wav);
        }
        durationsMs[seg.id] = await media.probeDurationMs(wav);
        if (!(durationsMs[seg.id] > 0)) throw new Error(`The audio for line ${seg.id} is empty.`);
      }

      const comp = buildComposition({ plan, durationsMs, brand, ctaText });
      const { mp4, durationMs } = await renderVideo({ files: comp.files, workDir: project, cfg, exec: deps.exec });

      // The preview is the hook scene (the first 6 seconds of it at most), the poster a frame 2 seconds in.
      const hook = Math.max(0, plan.segments.findIndex((s) => s.role === "hook"));
      const hookStart = comp.sceneStartsMs[hook] ?? 0;
      const hookLength = plan.segments.length ? (comp.sceneStartsMs[hook + 1] ?? hookStart + durationsMs[plan.segments[hook].id] + GAP_MS) - hookStart : durationMs;
      const gif = join(workDir, "preview.gif");
      const poster = join(workDir, "poster.jpg");
      await makeGif({ mp4, outPath: gif, startSeconds: hookStart / 1000, seconds: Math.min(GIF_SECONDS, Math.round(hookLength) / 1000), cfg, exec: deps.exec });
      await makePoster({ mp4, outPath: poster, atSeconds: Math.min(2, durationMs / 2000), cfg, exec: deps.exec });

      const bytes = (await stat(mp4)).size;
      await api.upload(job.id, out.mp4, mp4, "video/mp4");
      await api.upload(job.id, out.gif, gif, "image/gif");
      await api.upload(job.id, out.jpg, poster, "image/jpeg");
      return { videoKey: out.mp4, gifKey: out.gif, posterKey: out.jpg, durationMs, bytes };
    },
  };
}
