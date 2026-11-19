import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimedJob } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import type { Media } from "../src/ffmpeg.ts";
import type { JobApi } from "../src/loop.ts";
import { voiceSegmentHandler } from "../src/handlers/voiceSegment.ts";
import { voiceSampleHandler } from "../src/handlers/voiceSample.ts";
import { ENGINE_IDS, createEngines, type EngineId, type VoiceEngine } from "../src/voice/engine.ts";

let workDir: string;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "helper-voice-")); });
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const cfg = (): Config => ({
  apiBase: "https://x.example.com", token: "hlp_x", pollSeconds: 5, cacheDir: workDir,
  python: { "qwen3-tts": "/nope/q", chatterbox: "/nope/c", "openvoice-v2": "/nope/o" }, ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: "hyperframes",
});

const REF_BYTES = "REFERENCE-AUDIO";
function fakeApi() {
  const uploads: { jobId: string; key: string; body: string; contentType: string }[] = [];
  const downloads: { key: string }[] = [];
  const api: JobApi = {
    async hello() { return { serverTime: "", minHelperVersion: "0.1.0" }; },
    async claim() { return null; },
    async download(_id, key, to) { downloads.push({ key }); writeFileSync(to, REF_BYTES); },
    async upload(jobId, key, from, contentType) { uploads.push({ jobId, key, body: readFileSync(from, "utf8"), contentType }); },
    async complete() {}, async fail() {},
  };
  return { api, uploads, downloads };
}

/** An engine that writes a tag naming the text and reference it was given into the output, so a test can see exactly what reached it. */
function fakeEngine(id: EngineId, o: { ok?: boolean; why?: string } = {}) {
  const calls: { text: string; refBytes: string; refName: string }[] = [];
  const engine: VoiceEngine = {
    id,
    async available() { return o.ok === false ? { ok: false, why: o.why ?? "not installed" } : { ok: true }; },
    async synth({ text, refAudioPath, outPath }) {
      calls.push({ text, refBytes: readFileSync(refAudioPath, "utf8"), refName: basename(refAudioPath) });
      writeFileSync(outPath, `${id}:${text}`);
    },
  };
  return { engine, calls };
}

/** ffmpeg stand-ins: conversion copies the bytes, and every file is 4200 ms long. */
const media = (durationMs = 4200): Media => ({
  async toWav(inFile, outFile) { writeFileSync(outFile, `wav(${readFileSync(inFile, "utf8")})`); },
  async toRefWav(inFile, outFile) { writeFileSync(outFile, readFileSync(inFile)); },
  async probeDurationMs() { return durationMs; },
});

const segJob = (over: Partial<ClaimedJob> = {}, payload: Record<string, unknown> = {}): ClaimedJob => ({
  id: "job-1", kind: "voice.segment", attempts: 1,
  payload: { videoId: "v1", segmentId: "s1", engine: "chatterbox", text: "Hello there.", refKey: "voice-reference/reference.m4a", ...payload },
  inputs: ["voice-reference/reference.m4a"], outputs: ["video/v1/audio/s1-1a2b3c4d.wav"], ...over,
});
const sampleJob = (engine: EngineId, over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: `sample-${engine}`, kind: "voice.sample", attempts: 1,
  payload: { testId: "t1", engine, line: "Your homepage loads in four seconds.", refKey: "voice-reference/reference.m4a" },
  inputs: ["voice-reference/reference.m4a"], outputs: [`voice-tests/t1/${engine}.wav`], ...over,
});
const engines = (all: Partial<Record<EngineId, ReturnType<typeof fakeEngine>>> = {}) =>
  Object.fromEntries(ENGINE_IDS.map((id) => [id, (all[id] ?? fakeEngine(id)).engine])) as Record<EngineId, VoiceEngine>;

describe("voice.segment", () => {
  it("voice.segment uploads to the hashed key and returns its duration", async () => {
    const f = fakeApi();
    const e = fakeEngine("chatterbox");
    const h = voiceSegmentHandler(engines({ chatterbox: e }), media(5321));
    const result = await h.run({ job: segJob(), api: f.api, cfg: cfg(), workDir });
    expect(result).toEqual({ key: "video/v1/audio/s1-1a2b3c4d.wav", durationMs: 5321 });
    expect(f.uploads).toEqual([{ jobId: "job-1", key: "video/v1/audio/s1-1a2b3c4d.wav", body: "wav(chatterbox:Hello there.)", contentType: "audio/wav" }]);
    expect(f.downloads).toEqual([{ key: "voice-reference/reference.m4a" }]);
    expect(e.calls).toEqual([{ text: "Hello there.", refBytes: REF_BYTES, refName: expect.stringMatching(/\.wav$/) }]);
  });

  it("uses the output key the server listed, never one it builds itself", async () => {
    const f = fakeApi();
    const h = voiceSegmentHandler(engines(), media());
    const r = (await h.run({ job: segJob({ outputs: ["video/v1/audio/s1-ffffffff.wav"] }), api: f.api, cfg: cfg(), workDir })) as { key: string };
    expect(r.key).toBe("video/v1/audio/s1-ffffffff.wav");
    expect(f.uploads[0].key).toBe("video/v1/audio/s1-ffffffff.wav");
  });

  it("an unavailable engine fails the job with the engine's reason", async () => {
    const f = fakeApi();
    const e = fakeEngine("qwen3-tts", { ok: false, why: "mlx_audio is not installed in the venv" });
    const h = voiceSegmentHandler(engines({ "qwen3-tts": e }), media());
    await expect(h.run({ job: segJob({}, { engine: "qwen3-tts" }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/mlx_audio is not installed in the venv/);
    expect(e.calls).toEqual([]);
    expect(f.uploads).toEqual([]);
  });

  it("fails clearly when the job carries no reference recording", async () => {
    const f = fakeApi();
    const h = voiceSegmentHandler(engines(), media());
    await expect(h.run({ job: segJob({ inputs: [] }, { refKey: undefined }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/reference/i);
  });

  it("fails when the engine produced silence, instead of uploading it", async () => {
    const f = fakeApi();
    const h = voiceSegmentHandler(engines(), media(0));
    await expect(h.run({ job: segJob(), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/no audio|empty/i);
    expect(f.uploads).toEqual([]);
  });

  it("fails on a payload that is not a voice.segment job", async () => {
    const f = fakeApi();
    const h = voiceSegmentHandler(engines(), media());
    await expect(h.run({ job: segJob({}, { engine: "espeak" }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/engine/);
    await expect(h.run({ job: segJob({}, { text: "" }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/text/);
  });

  it("fails when the server listed no single output", async () => {
    const f = fakeApi();
    const h = voiceSegmentHandler(engines(), media());
    await expect(h.run({ job: segJob({ outputs: [] }), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/output/);
  });
});

describe("voice.sample", () => {
  it("voice.sample for each engine uses the same line and reference", async () => {
    const f = fakeApi();
    const all = { "qwen3-tts": fakeEngine("qwen3-tts"), chatterbox: fakeEngine("chatterbox"), "openvoice-v2": fakeEngine("openvoice-v2") };
    const h = voiceSampleHandler(engines(all), media(3100));
    for (const id of ENGINE_IDS) {
      const dir = join(workDir, id); // one work dir per job, as the loop makes
      (await import("node:fs")).mkdirSync(dir);
      const r = await h.run({ job: sampleJob(id), api: f.api, cfg: cfg(), workDir: dir });
      expect(r).toEqual({ durationMs: 3100 });
    }
    for (const id of ENGINE_IDS) {
      expect(all[id].calls).toEqual([{ text: "Your homepage loads in four seconds.", refBytes: REF_BYTES, refName: expect.stringMatching(/\.wav$/) }]);
    }
    expect(f.uploads.map((u) => u.key)).toEqual(["voice-tests/t1/qwen3-tts.wav", "voice-tests/t1/chatterbox.wav", "voice-tests/t1/openvoice-v2.wav"]);
    expect(new Set(f.downloads.map((d) => d.key))).toEqual(new Set(["voice-reference/reference.m4a"]));
  });

  it("an unavailable engine fails its sample with the engine's reason", async () => {
    const f = fakeApi();
    const h = voiceSampleHandler(engines({ "openvoice-v2": fakeEngine("openvoice-v2", { ok: false, why: "no checkpoints" }) }), media());
    await expect(h.run({ job: sampleJob("openvoice-v2"), api: f.api, cfg: cfg(), workDir })).rejects.toThrow(/no checkpoints/);
    expect(f.uploads).toEqual([]);
  });
});

describe("the engine adapters", () => {
  it("run the right script in the right venv, with the text in a file and the paths as arguments", async () => {
    const calls: { py: string; script: string; args: string[]; textInFile?: string }[] = [];
    const run = async (py: string, script: string, args: string[]) => {
      const textFile = args[args.indexOf("--text-file") + 1];
      calls.push({ py, script: basename(script), args, textInFile: textFile ? readFileSync(textFile, "utf8") : undefined });
      const out = args[args.indexOf("--out") + 1];
      if (out) writeFileSync(out, "audio");
    };
    const c = { ...cfg(), python: { "qwen3-tts": process.execPath, chatterbox: process.execPath, "openvoice-v2": process.execPath } };
    const all = createEngines(c, run);
    const ref = join(workDir, "ref.wav"); writeFileSync(ref, "r");
    const text = `-- looks like a flag; "quotes" and a\nnewline`;
    await all["chatterbox"].synth({ text, refAudioPath: ref, outPath: join(workDir, "o.wav") });
    await all["qwen3-tts"].synth({ text: "x", refAudioPath: ref, outPath: join(workDir, "o2.wav") });
    await all["openvoice-v2"].synth({ text: "y", refAudioPath: ref, outPath: join(workDir, "o3.wav") });
    expect(calls.map((x) => x.script)).toEqual(["chatterbox.py", "qwen3.py", "openvoice.py"]);
    expect(calls[0].py).toBe(process.execPath);
    expect(calls[0].textInFile).toBe(text);
    expect(calls[0].args).toEqual(expect.arrayContaining(["--ref", ref, "--out", join(workDir, "o.wav")]));
    expect(calls[0].args).not.toContain(text);
  });

  it("available() says so when there is no Python at the configured path", async () => {
    const all = createEngines(cfg(), async () => {});
    const r = await all["chatterbox"].available();
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/\/nope\/c/);
  });

  it("available() runs the script's --check and passes its failure on", async () => {
    const c = { ...cfg(), python: { ...cfg().python, chatterbox: process.execPath } };
    const bad = createEngines(c, async () => { throw new Error("ModuleNotFoundError: No module named 'chatterbox'"); });
    expect(await bad["chatterbox"].available()).toEqual({ ok: false, why: expect.stringMatching(/No module named 'chatterbox'/) });
    let checks = 0;
    const good = createEngines(c, async (_py, _s, args) => { if (args.includes("--check")) checks++; });
    expect((await good["chatterbox"].available()).ok).toBe(true);
    expect((await good["chatterbox"].available()).ok).toBe(true);
    expect(checks).toBe(1); // a success is remembered, so the import is not paid for per line
  });

  it("synth fails when the script exits cleanly but wrote nothing", async () => {
    const c = { ...cfg(), python: { ...cfg().python, chatterbox: process.execPath } };
    const all = createEngines(c, async () => {});
    const ref = join(workDir, "ref.wav"); writeFileSync(ref, "r");
    await expect(all["chatterbox"].synth({ text: "x", refAudioPath: ref, outPath: join(workDir, "none.wav") })).rejects.toThrow(/no audio/);
  });
});
