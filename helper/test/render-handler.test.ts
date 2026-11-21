import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import type { Exec } from "../src/exec.ts";
import type { Media } from "../src/ffmpeg.ts";
import { renderHandler } from "../src/handlers/render.ts";
import type { JobApi } from "../src/loop.ts";
import { MAX_GIF_BYTES, makeGif } from "../src/render/gif.ts";
import { MAX_VIDEO_BYTES, renderVideo } from "../src/render/render.ts";

const MB = 1024 * 1024;
let workDir: string;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "helper-render-")); });
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const cfg = (): Config => ({
  apiBase: "https://x.example.com", token: "hlp_x", pollSeconds: 5, cacheDir: workDir,
  python: { "qwen3-tts": "/nope/q", chatterbox: "/nope/c", "openvoice-v2": "/nope/o" }, ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: "hyperframes", meetilyDb: "/nope/meeting_minutes.sqlite",
});

const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** Stand-ins for hyperframes, ffmpeg and ffprobe that write files of the sizes a test asks for, and remember every call. */
function fakeTools(o: { encodes?: number[]; gifs?: number[]; mp4Ms?: number } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const encodes = [...(o.encodes ?? [5 * MB])];
  const gifs = [...(o.gifs ?? [1 * MB])];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === "hyperframes") {
      const out = flag(args, "-o")!;
      writeFileSync(out, Buffer.alloc(encodes.length > 1 ? encodes.shift()! : encodes[0]));
      return { stdout: "" };
    }
    if (file === "ffprobe") return { stdout: JSON.stringify({ format: { duration: String((o.mp4Ms ?? 17_050) / 1000) }, streams: [] }) };
    if (file === "ffmpeg") {
      const out = args[args.length - 1];
      if (args.some((a) => a.includes("palettegen"))) writeFileSync(out, Buffer.alloc(gifs.length > 1 ? gifs.shift()! : gifs[0]));
      else if (args.includes("+faststart")) writeFileSync(out, readFileSync(args[args.indexOf("-i") + 1]));
      else writeFileSync(out, Buffer.from([255, 216, 255, 1])); // the poster
      return { stdout: "" };
    }
    throw new Error(`unexpected program ${file}`);
  };
  return { exec, calls, hf: () => calls.filter((c) => c.file === "hyperframes"), gifCalls: () => calls.filter((c) => c.args.some((a) => a.includes("palettegen"))) };
}

describe("renderVideo", () => {
  const files = { "index.html": "<html></html>" };

  it("renders a 1280 by 720, 30 fps MP4 with the project and moves its index to the front for streaming", async () => {
    const t = fakeTools();
    const r = await renderVideo({ files, workDir, cfg: cfg(), exec: t.exec });
    expect(readFileSync(join(workDir, "index.html"), "utf8")).toBe("<html></html>");
    const hf = t.hf();
    expect(hf).toHaveLength(1);
    expect(hf[0].args[0]).toBe("render");
    expect(hf[0].args).toContain(workDir);
    expect(flag(hf[0].args, "--fps")).toBe("30");
    // the remux that puts the index at the front of the file
    const remux = t.calls.find((c) => c.file === "ffmpeg" && c.args.includes("+faststart"))!;
    expect(remux.args).toEqual(expect.arrayContaining(["-c", "copy", "-movflags", "+faststart"]));
    expect(r.durationMs).toBe(17_050);
    expect(statSync(r.mp4).size).toBe(5 * MB);
  });

  it("an oversize first encode retries once at a lower bitrate", async () => {
    const t = fakeTools({ encodes: [41 * MB, 30 * MB] });
    const r = await renderVideo({ files, workDir, cfg: cfg(), exec: t.exec });
    const hf = t.hf();
    expect(hf).toHaveLength(2);
    expect(hf[0].args).not.toContain("--video-bitrate");
    const kbps = flag(hf[1].args, "--video-bitrate")!;
    expect(kbps).toMatch(/^\d+k$/);
    // 17 seconds can carry far more than the 40 MB limit allows for, so the retry is capped, not zero
    expect(Number.parseInt(kbps, 10)).toBeGreaterThan(0);
    expect(statSync(r.mp4).size).toBe(30 * MB);
    expect(statSync(r.mp4).size).toBeLessThanOrEqual(MAX_VIDEO_BYTES);
  });

  it("the retry's bitrate is worked out so the file fits: a long video gets a lower one", async () => {
    const short = fakeTools({ encodes: [41 * MB, 30 * MB], mp4Ms: 60_000 });
    await renderVideo({ files, workDir, cfg: cfg(), exec: short.exec });
    const long = fakeTools({ encodes: [41 * MB, 30 * MB], mp4Ms: 130_000 });
    await renderVideo({ files, workDir: mkdtempSync(join(tmpdir(), "helper-render2-")), cfg: cfg(), exec: long.exec });
    const kb = (t: ReturnType<typeof fakeTools>) => Number.parseInt(flag(t.hf()[1].args, "--video-bitrate")!, 10);
    expect(kb(long)).toBeLessThan(kb(short));
  });

  it("fails with its size when the retry is still over 40 MB, and does not try a third time", async () => {
    const t = fakeTools({ encodes: [45 * MB, 43 * MB] });
    await expect(renderVideo({ files, workDir, cfg: cfg(), exec: t.exec })).rejects.toThrow(/43\.0 MB.*40 MB|40 MB.*43\.0 MB/);
    expect(t.hf()).toHaveLength(2);
  });

  it("a hyperframes failure is passed on with its words", async () => {
    const exec: Exec = async (file) => { if (file === "hyperframes") throw new Error("hyperframes exited with code 1: Chrome not found"); return { stdout: "" }; };
    await expect(renderVideo({ files, workDir, cfg: cfg(), exec })).rejects.toThrow(/Chrome not found/);
  });
});

describe("makeGif", () => {
  it("the gif is 480 px wide, 8 frames a second, the first 6 seconds, with a palette made for it", async () => {
    const t = fakeTools();
    const out = join(workDir, "preview.gif");
    await makeGif({ mp4: join(workDir, "v.mp4"), outPath: out, seconds: 6, cfg: cfg(), exec: t.exec });
    const a = t.gifCalls()[0].args;
    expect(flag(a, "-t")).toBe("6");
    const vf = a.find((x) => x.includes("palettegen"))!;
    expect(vf).toContain("fps=8");
    expect(vf).toContain("scale=480");
    expect(vf).toContain("palettegen");
    expect(vf).toContain("paletteuse");
    expect(statSync(out).size).toBeLessThanOrEqual(MAX_GIF_BYTES);
  });

  it("a hook scene shorter than 6 seconds makes a shorter gif", async () => {
    const t = fakeTools();
    await makeGif({ mp4: join(workDir, "v.mp4"), outPath: join(workDir, "p.gif"), seconds: 4.35, cfg: cfg(), exec: t.exec });
    expect(flag(t.gifCalls()[0].args, "-t")).toBe("4.35");
  });

  it("tries again with fewer colours when the first gif is over the limit", async () => {
    const t = fakeTools({ gifs: [2 * MB, 1 * MB] });
    await makeGif({ mp4: join(workDir, "v.mp4"), outPath: join(workDir, "p.gif"), seconds: 6, cfg: cfg(), exec: t.exec });
    const [first, second] = t.gifCalls().map((c) => c.args.find((x) => x.includes("palettegen"))!);
    expect(t.gifCalls()).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(second).toMatch(/max_colors=(\d+)/);
    expect(Number(/max_colors=(\d+)/.exec(second)![1])).toBeLessThan(Number(/max_colors=(\d+)/.exec(first)?.[1] ?? 256));
  });

  it("the gif is capped at 1.5 MB or the handler fails with its size", async () => {
    const t = fakeTools({ gifs: [2 * MB, 1.8 * MB, 1.6 * MB] });
    await expect(makeGif({ mp4: join(workDir, "v.mp4"), outPath: join(workDir, "p.gif"), seconds: 6, cfg: cfg(), exec: t.exec })).rejects.toThrow(/1\.6 MB.*1\.5 MB/);
    expect(MAX_GIF_BYTES).toBe(1.5 * MB);
  });
});

describe("render handler", () => {
  const OUT = { mp4: "video/v1/out/v7.mp4", gif: "video/v1/out/v7.gif", jpg: "video/v1/out/v7.jpg" };
  const plan = {
    shots: [{ id: "d1", viewport: "desktop", scrollY: 0, width: 1280, height: 2400, fullKey: "video/v1/shots/d1.jpg", previewKey: "video/v1/shots/d1.preview.jpg" }],
    segments: [
      { id: "s1", role: "hook", text: "one", shotId: "d1", markups: [], audio: { key: "video/v1/audio/s1-aaaaaaaa.wav", source: "clone", durationMs: 111, textHash: "aaaaaaaa" } },
      { id: "s2", role: "problem", text: "two", shotId: "d1", markups: [{ type: "circle", x: 0.5, y: 0.5, r: 0.1 }], audio: { key: "video/v1/recordings/s2-bbbbbbbb.webm", source: "recorded", durationMs: 222, textHash: "bbbbbbbb" } },
      { id: "s3", role: "cta", text: "three", shotId: "d1", markups: [], audio: { key: "video/v1/audio/s3-cccccccc.wav", source: "clone", durationMs: 333, textHash: "cccccccc" } },
    ],
  };
  const job = (over: Partial<ClaimedJob> = {}, payload: Record<string, unknown> = {}): ClaimedJob => ({
    id: "job-1", kind: "render", attempts: 1,
    payload: { videoId: "v1", planVersion: 7, plan, brand: { name: "Logan Irish", business: "Siteline" }, ctaText: "Book a call", inputs: [], ...payload },
    inputs: ["video/v1/shots/d1.jpg", "video/v1/audio/s1-aaaaaaaa.wav", "video/v1/recordings/s2-bbbbbbbb.webm", "video/v1/audio/s3-cccccccc.wav"],
    outputs: [OUT.mp4, OUT.gif, OUT.jpg], ...over,
  });

  function fakeApi() {
    const uploads: { key: string; contentType: string; bytes: number }[] = [];
    const downloads: string[] = [];
    const api: JobApi = {
      async hello() { return { serverTime: "", minHelperVersion: "0.1.0" }; },
      async claim() { return null; },
      async download(_id, key, to) { downloads.push(key); writeFileSync(to, `bytes of ${key}`); },
      async upload(_id, key, from, contentType) { uploads.push({ key, contentType, bytes: statSync(from).size }); },
      async complete() {}, async fail() {},
    };
    return { api, uploads, downloads };
  }

  /** Conversion adds `wav(...)` around the bytes; every wav is as long as its name says (s1 4000, s2 3000, s3 5000). */
  function fakeMedia() {
    const converted: string[] = [];
    const probed: string[] = [];
    const lengths: Record<string, number> = { s1: 4000, s2: 3000, s3: 5000 };
    const media: Media = {
      async toWav(i, o) { converted.push(basename(i)); writeFileSync(o, `wav(${readFileSync(i, "utf8")})`); },
      async toRefWav(i, o) { writeFileSync(o, readFileSync(i)); },
      async probeDurationMs(f) { probed.push(basename(f)); return lengths[/line-(s\d)/.exec(f)![1]]; },
    };
    return { media, converted, probed };
  }

  it("downloads the shots and every line's audio, measures them, renders, uploads the three files and reports", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools({ encodes: [6 * MB], gifs: [800_000] });
    const h = renderHandler(m.media, { exec: t.exec });
    const result = await h.run({ job: job(), api: f.api, cfg: cfg(), workDir });
    expect(f.downloads.sort()).toEqual(job().inputs.sort());
    expect(f.uploads).toEqual([
      { key: OUT.mp4, contentType: "video/mp4", bytes: 6 * MB },
      { key: OUT.gif, contentType: "image/gif", bytes: 800_000 },
      { key: OUT.jpg, contentType: "image/jpeg", bytes: 4 },
    ]);
    expect(result).toEqual({ videoKey: OUT.mp4, gifKey: OUT.gif, posterKey: OUT.jpg, durationMs: 17_050, bytes: 6 * MB });
    // the page the renderer was given uses the measured lengths (4000, 3000, 5000), not the stored ones
    const page = readFileSync(join(workDir, "project", "index.html"), "utf8");
    expect(page).toContain('data-start="7.7"');
    expect(m.probed.sort()).toEqual(["line-s1.wav", "line-s2.wav", "line-s3.wav"]);
    // the gif is of the hook scene (4 s of speech and the gap: 4.35 s), the poster is at 2 s
    expect(t.gifCalls()[0].args[t.gifCalls()[0].args.indexOf("-t") + 1]).toBe("4.35");
    const poster = t.calls.find((c) => c.file === "ffmpeg" && c.args.includes("-frames:v"))!;
    expect(poster.args[poster.args.indexOf("-ss") + 1]).toBe("2");
  });

  it("recorded webm lines are converted before use, and cloned ones are not", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools();
    await renderHandler(m.media, { exec: t.exec }).run({ job: job(), api: f.api, cfg: cfg(), workDir });
    expect(m.converted).toEqual(["line-s2.webm"]);
    // what the page plays is the converted wav, under the name the composition expects
    expect(readFileSync(join(workDir, "project", "assets", "line-s2.wav"), "utf8")).toBe("wav(bytes of video/v1/recordings/s2-bbbbbbbb.webm)");
    expect(readFileSync(join(workDir, "project", "assets", "line-s1.wav"), "utf8")).toBe("bytes of video/v1/audio/s1-aaaaaaaa.wav");
    expect(existsSync(join(workDir, "project", "assets", "shot-d1.jpg"))).toBe(true);
  });

  it("uses the keys the claim lists: the output keys are not worked out again", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools();
    const outs = ["x/out/final.mp4", "x/out/final.gif", "x/out/final.jpg"];
    const result = await renderHandler(m.media, { exec: t.exec }).run({ job: job({ outputs: outs }), api: f.api, cfg: cfg(), workDir }) as { videoKey: string };
    expect(f.uploads.map((u) => u.key)).toEqual(outs);
    expect(result.videoKey).toBe("x/out/final.mp4");
  });

  it("refuses a job whose input list lacks a file the plan needs", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools();
    const j = job({ inputs: ["video/v1/shots/d1.jpg", "video/v1/audio/s1-aaaaaaaa.wav"] });
    await expect(renderHandler(m.media, { exec: t.exec }).run({ job: j, api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/s2-bbbbbbbb\.webm|not one of this job's inputs/);
    expect(t.hf()).toHaveLength(0);
  });

  it("refuses a job without the three output files", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools();
    await expect(renderHandler(m.media, { exec: t.exec }).run({ job: job({ outputs: [OUT.mp4] }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/\.gif|three output/);
  });

  it("fails with the gif's size when the gif cannot be made small enough", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools({ gifs: [3 * MB] });
    await expect(renderHandler(m.media, { exec: t.exec }).run({ job: job(), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/3\.0 MB.*1\.5 MB/);
    expect(f.uploads).toEqual([]); // nothing is uploaded for a render that is going to fail
  });

  it("a line with no audio in the plan is a clear error", async () => {
    const f = fakeApi(); const m = fakeMedia(); const t = fakeTools();
    const p = JSON.parse(JSON.stringify(plan)); delete p.segments[1].audio;
    await expect(renderHandler(m.media, { exec: t.exec }).run({ job: job({}, { plan: p }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/s2.*audio|audio.*s2/);
  });
});
