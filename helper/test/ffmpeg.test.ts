import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { parseProbe, probeDurationMs, toRefWav, toWav } from "../src/ffmpeg.ts";

const fixture = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", n), "utf8");
const cfg = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" } as Config;

describe("parseProbe", () => {
  it("parseProbe reads seconds into milliseconds", () => {
    expect(parseProbe(fixture("ffprobe-wav.json"))).toBe(3482);
    expect(parseProbe(fixture("ffprobe-stream-only.json"))).toBe(12041);
  });
  it("refuses output with no duration, and output that is not JSON", () => {
    expect(() => parseProbe(fixture("ffprobe-no-duration.json"))).toThrow(/duration/);
    expect(() => parseProbe("not json")).toThrow(/ffprobe/);
  });
});

describe("with a fake process runner", () => {
  it("probeDurationMs asks ffprobe for JSON and parses it", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = async (file: string, args: string[]) => { calls.push({ file, args }); return { stdout: fixture("ffprobe-wav.json") }; };
    expect(await probeDurationMs("/w/out.wav", cfg, exec)).toBe(3482);
    expect(calls[0].file).toBe("ffprobe");
    expect(calls[0].args).toContain("json");
    expect(calls[0].args.at(-1)).toBe("/w/out.wav");
  });

  it("toWav makes mono 24 kHz PCM and loudness-normalises with loudnorm", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = async (file: string, args: string[]) => { calls.push({ file, args }); return { stdout: "" }; };
    await toWav("/w/raw.mp3", "/w/out.wav", cfg, exec);
    const a = calls[0].args.join(" ");
    expect(calls[0].file).toBe("ffmpeg");
    expect(a).toMatch(/-ac 1/);
    expect(a).toMatch(/-ar 24000/);
    expect(a).toMatch(/pcm_s16le/);
    expect(a).toMatch(/loudnorm/);
    expect(calls[0].args.at(-1)).toBe("/w/out.wav");
    expect(calls[0].args).toContain("/w/raw.mp3");
  });

  it("toRefWav converts to mono 24 kHz without touching the loudness", async () => {
    const calls: { args: string[] }[] = [];
    await toRefWav("/w/ref.m4a", "/w/ref.wav", cfg, async (_f, args) => { calls.push({ args }); return { stdout: "" }; });
    const a = calls[0].args.join(" ");
    expect(a).toMatch(/-ac 1/);
    expect(a).not.toMatch(/loudnorm/);
  });
});

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

describe.skipIf(!hasFfmpeg)("with the real ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "helper-ffmpeg-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("converts a stereo 44.1 kHz tone to a mono 24 kHz wav of the same length", async () => {
    const src = join(dir, "tone.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5:sample_rate=44100", "-ac", "2", src]);
    const out = join(dir, "out.wav");
    await toWav(src, out, cfg);
    expect(existsSync(out)).toBe(true);
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", out], { encoding: "utf8" }));
    expect(info.streams[0].sample_rate).toBe("24000");
    expect(info.streams[0].channels).toBe(1);
    expect(info.streams[0].codec_name).toBe("pcm_s16le");
    const ms = await probeDurationMs(out, cfg);
    expect(ms).toBeGreaterThan(1400);
    expect(ms).toBeLessThan(1700);
  });
});
