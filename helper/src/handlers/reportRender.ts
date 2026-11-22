import { join } from "node:path";
import type { Exec } from "../exec.ts";
import type { JobHandler } from "../loop.ts";
import { MAX_REPORT_SCENES, buildReportComposition, type ReportScene } from "../render/composition.ts";
import { makePoster } from "../render/gif.ts";
import { renderVideo } from "../render/render.ts";
import { payloadOf, textField } from "./clone.ts";

export const REPORT_RENDER_KIND = "report.render";

/** The job's two output files, by what they are: the claim lists exactly one .mp4 and one .jpg, and the helper writes to those and to no others. */
function outputsOf(outputs: string[]): { mp4: string; jpg: string } {
  const mp4 = outputs.filter((k) => k.toLowerCase().endsWith(".mp4"));
  const jpg = outputs.filter((k) => k.toLowerCase().endsWith(".jpg"));
  if (outputs.length !== 2 || mp4.length !== 1 || jpg.length !== 1) throw new Error("this job should list exactly two output files: one .mp4 and one .jpg");
  return { mp4: mp4[0], jpg: jpg[0] };
}

function scenesOf(p: Record<string, unknown>): ReportScene[] {
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) throw new Error("the job's scenes are missing");
  if (p.scenes.length > MAX_REPORT_SCENES) throw new Error(`the job has ${p.scenes.length} scenes and a report video has at most ${MAX_REPORT_SCENES}`);
  return p.scenes.map((s: unknown, i) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    for (const f of ["title", "big", "small"] as const) if (typeof o[f] !== "string") throw new Error(`scene ${i + 1} has no ${f} text`);
    return { title: o.title as string, big: o.big as string, small: o.small as string };
  });
}

/**
 * `report.render`: the short silent video of a Care or Local SEO report. Payload `{ videoId, scenes, brand: { name }, outputs }`; result `{ videoKey, posterKey, durationMs }`. It reads nothing from the server: the
 * scenes are the whole input. It has HyperFrames render the page `buildReportComposition` makes (1080 x 1080, silent), takes the first frame as the poster and uploads exactly the two files the claim lists,
 * and only if both were made.
 */
export function reportRenderHandler(deps: { exec?: Exec } = {}): JobHandler {
  return {
    kind: REPORT_RENDER_KIND,
    async run({ job, api, cfg, workDir }) {
      const p = payloadOf(job);
      textField(p, "videoId");
      const out = outputsOf(job.outputs);
      const scenes = scenesOf(p);
      const brand = (p.brand && typeof p.brand === "object" ? p.brand : {}) as Record<string, unknown>;
      const comp = buildReportComposition(scenes, { name: typeof brand.name === "string" ? brand.name : "" });

      const { mp4, durationMs } = await renderVideo({ files: comp.files, workDir: join(workDir, "project"), cfg, exec: deps.exec });
      const poster = join(workDir, "poster.jpg");
      await makePoster({ mp4, outPath: poster, atSeconds: 0, cfg, exec: deps.exec });

      await api.upload(job.id, out.mp4, mp4, "video/mp4");
      await api.upload(job.id, out.jpg, poster, "image/jpeg");
      return { videoKey: out.mp4, posterKey: out.jpg, durationMs };
    },
  };
}
