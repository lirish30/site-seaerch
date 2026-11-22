import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import type { Exec } from "../src/exec.ts";
import { reportRenderHandler } from "../src/handlers/reportRender.ts";
import type { JobApi } from "../src/loop.ts";
import { GSAP_SRI, GSAP_URL, REPORT_FRAME, REPORT_SCENE_MS, buildReportComposition, type ReportScene } from "../src/render/composition.ts";

let workDir: string;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "helper-report-render-")); });
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const cfg = (): Config => ({
  apiBase: "https://x.example.com", token: "hlp_x", pollSeconds: 5, cacheDir: workDir,
  python: { "qwen3-tts": "/nope/q", chatterbox: "/nope/c", "openvoice-v2": "/nope/o" }, ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: "hyperframes", chrome: "chrome", meetilyDb: "/nope/meeting_minutes.sqlite",
});

const scene = (i: number): ReportScene => ({ title: `Title ${i}`, big: `Big ${i}`, small: `Small ${i} words` });
const scenes = (n: number): ReportScene[] => Array.from({ length: n }, (_, i) => scene(i + 1));
const OUT = { mp4: "report-video/care/r1/v1.mp4", jpg: "report-video/care/r1/v1.jpg" };

const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** Stand-ins for hyperframes, ffmpeg and ffprobe that write small files and remember every call. */
function fakeTools(mp4Ms = 24_000) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === "hyperframes") { writeFileSync(flag(args, "-o")!, Buffer.alloc(2048)); return { stdout: "" }; }
    if (file === "ffprobe") return { stdout: JSON.stringify({ format: { duration: String(mp4Ms / 1000) }, streams: [] }) };
    if (file === "ffmpeg") {
      const out = args[args.length - 1];
      if (args.includes("+faststart")) writeFileSync(out, readFileSync(args[args.indexOf("-i") + 1]));
      else writeFileSync(out, Buffer.from([255, 216, 255, 1])); // the poster
      return { stdout: "" };
    }
    throw new Error(`unexpected program ${file}`);
  };
  return { exec, calls };
}

function fakeApi() {
  const uploads: { key: string; contentType: string; bytes: number }[] = [];
  const downloads: string[] = [];
  const api: JobApi = {
    async hello() { return { serverTime: "", minHelperVersion: "0.1.0" }; },
    async claim() { return null; },
    async download(_id, key) { downloads.push(key); },
    async upload(_id, key, from, contentType) { uploads.push({ key, contentType, bytes: statSync(from).size }); },
    async touch() {}, async complete() {}, async fail() {},
  };
  return { api, uploads, downloads };
}

const job = (over: Partial<ClaimedJob> = {}, payload: Record<string, unknown> = {}): ClaimedJob => ({
  id: "job-1", kind: "report.render", attempts: 1,
  payload: { videoId: "v1", scenes: scenes(4), brand: { name: "Siteline" }, outputs: [OUT.mp4, OUT.jpg], ...payload },
  inputs: [], outputs: [OUT.mp4, OUT.jpg], ...over,
});

describe("buildReportComposition", () => {
  const page = (s: ReportScene[] = scenes(4)) => buildReportComposition(s, { name: "Siteline" }).files["index.html"];

  it("buildReportComposition puts every scene's title, big and small text in the composition", () => {
    const s = [{ title: "Acme Dental", big: "November 2026", small: "Your monthly report" }, { title: "Found on Google", big: "1,234", small: "Clicks from Google search to your site, counted by Google" }, { title: "Acme Dental", big: "Thank you", small: "The full report is on this page" }];
    const r = buildReportComposition(s, { name: "Siteline" });
    const h = r.files["index.html"];
    for (const x of s) for (const t of [x.title, x.big, x.small]) expect(h).toContain(t);
    expect(h).toContain("Siteline");
    // one scene each, 6 seconds apart, and the page is square and silent
    expect(r.sceneStartsMs).toEqual([0, 6000, 12_000]);
    expect(r.totalMs).toBe(3 * REPORT_SCENE_MS);
    expect(REPORT_FRAME).toBe(1080);
    expect(h).toContain('data-width="1080"');
    expect(h).toContain('data-height="1080"');
    expect(h).toContain('data-duration="18"');
    expect(h).not.toMatch(/<audio|<video/);
    // the same pinned GSAP the other render uses, and nothing else from the network
    expect(h).toContain(`src="${GSAP_URL}"`);
    expect(h).toContain(GSAP_SRI);
    expect([...h.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1])).toEqual([GSAP_URL]);
  });

  it("shows a scene's words as text, never as markup", () => {
    const h = page([{ title: "A <script>alert(1)</script> & co", big: '"5" <b>', small: "it's" }]);
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("A &lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(h).toContain("&quot;5&quot; &lt;b&gt;");
  });

  it("fades each scene in over a second, and every scene but the last out again", () => {
    const h = page();
    expect(h.match(/class="scene clip"/g)).toHaveLength(4);
    expect([...h.matchAll(/id="sc\d" data-start="([\d.]+)" data-duration="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])])).toEqual([[0, 6], [6, 6], [12, 6], [18, 6]]);
    expect(h).toContain("duration: 1");
  });

  it("refuses no scenes and more than six", () => {
    expect(() => buildReportComposition([], { name: "Siteline" })).toThrow(/scene/);
    expect(() => buildReportComposition(scenes(7), { name: "Siteline" })).toThrow(/at most 6/);
    expect(() => buildReportComposition(scenes(6), { name: "Siteline" })).not.toThrow();
  });
});

describe("reportRender handler", () => {
  it("reportRender writes exactly the two listed outputs and refuses a seventh scene", async () => {
    const f = fakeApi(); const t = fakeTools(24_000);
    const result = await reportRenderHandler({ exec: t.exec }).run({ job: job(), api: f.api, cfg: cfg(), workDir });
    expect(f.uploads).toEqual([
      { key: OUT.mp4, contentType: "video/mp4", bytes: 2048 },
      { key: OUT.jpg, contentType: "image/jpeg", bytes: 4 },
    ]);
    expect(result).toEqual({ videoKey: OUT.mp4, posterKey: OUT.jpg, durationMs: 24_000 });
    expect(f.downloads).toEqual([]);
    // the page the renderer was given has every scene, and it was rendered with HyperFrames at the square size
    const html = readFileSync(join(workDir, "project", "index.html"), "utf8");
    for (const i of [1, 2, 3, 4]) expect(html).toContain(`Big ${i}`);
    const hf = t.calls.find((c) => c.file === "hyperframes")!;
    expect(hf.args[0]).toBe("render");
    expect(hf.args).toContain(join(workDir, "project"));
    // the poster is the first frame of the video
    const poster = t.calls.find((c) => c.file === "ffmpeg" && c.args.includes("-frames:v"))!;
    expect(poster.args[poster.args.indexOf("-ss") + 1]).toBe("0");
    expect(existsSync(join(workDir, "project", "index.html"))).toBe(true);
    // nothing else is written to the job's folder outside the project, the renders and the poster
    expect(readdirSync(workDir).sort()).toEqual(["poster.jpg", "project"]);

    // a seventh scene is refused before anything is rendered or uploaded
    const g = fakeApi(); const u = fakeTools();
    await expect(reportRenderHandler({ exec: u.exec }).run({ job: job({}, { scenes: scenes(7) }), api: g.api, cfg: cfg(), workDir })).rejects.toThrow(/at most 6/);
    expect(u.calls).toEqual([]);
    expect(g.uploads).toEqual([]);
  });

  it("refuses outputs that are not exactly one .mp4 and one .jpg", async () => {
    for (const outputs of [[OUT.mp4], [OUT.mp4, OUT.mp4], [OUT.jpg, OUT.jpg], [OUT.mp4, OUT.jpg, "report-video/care/r1/v1.gif"], [OUT.mp4, "report-video/care/r1/v1.png"], []]) {
      const f = fakeApi(); const t = fakeTools();
      await expect(reportRenderHandler({ exec: t.exec }).run({ job: job({ outputs }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/\.mp4/);
      expect(t.calls).toEqual([]);
      expect(f.uploads).toEqual([]);
    }
  });

  it("uses the keys the claim lists, whatever order they come in", async () => {
    const f = fakeApi(); const t = fakeTools();
    const result = await reportRenderHandler({ exec: t.exec }).run({ job: job({ outputs: ["x/p.jpg", "x/v.mp4"] }), api: f.api, cfg: cfg(), workDir });
    expect(f.uploads.map((u) => u.key)).toEqual(["x/v.mp4", "x/p.jpg"]);
    expect(result).toMatchObject({ videoKey: "x/v.mp4", posterKey: "x/p.jpg" });
  });

  it("refuses a payload without scenes or with a scene that has no words", async () => {
    const f = fakeApi(); const t = fakeTools();
    await expect(reportRenderHandler({ exec: t.exec }).run({ job: job({}, { scenes: undefined }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/scenes/);
    await expect(reportRenderHandler({ exec: t.exec }).run({ job: job({}, { scenes: [{ title: "a", big: 5, small: "c" }] }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/scene/);
    expect(t.calls).toEqual([]);
  });

  it("is the kind the server hands out", () => {
    expect(reportRenderHandler().kind).toBe("report.render");
  });
});
