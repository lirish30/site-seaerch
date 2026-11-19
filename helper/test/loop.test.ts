import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, TokenRevoked, type ClaimedJob } from "../src/api.ts";
import type { Config } from "../src/config.ts";
import { runLoop, type JobApi, type JobHandler } from "../src/loop.ts";

let cacheDir: string;
beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), "helper-loop-")); });
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const cfg = (): Config => ({
  apiBase: "https://x.example.com", token: "hlp_x", pollSeconds: 5, cacheDir,
  python: { "qwen3-tts": "p", chatterbox: "p", "openvoice-v2": "p" }, ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: "hyperframes",
});
const job = (id: string, kind = "voice.segment"): ClaimedJob => ({ id, kind, attempts: 1, payload: {}, inputs: [], outputs: [] });

/** claim answers from a script (a job, null for idle, or an Error to throw); past its end it says the token was revoked, so a loop with no `once` always stops. */
function fakeApi(script: (ClaimedJob | null | Error)[]) {
  const completes: { id: string; result: unknown }[] = [];
  const fails: { id: string; error: string }[] = [];
  const claims: string[][] = [];
  const api: JobApi = {
    async hello() { return { serverTime: "", minHelperVersion: "0.1.0" }; },
    async claim(kinds) {
      claims.push(kinds);
      const n = script.shift();
      if (n === undefined) throw new TokenRevoked();
      if (n instanceof Error) throw n;
      return n;
    },
    async download() {}, async upload() {},
    async complete(id, result) { completes.push({ id, result }); },
    async fail(id, error) { fails.push({ id, error }); },
  };
  return { api, completes, fails, claims };
}
const sleeper = () => { const slept: number[] = []; return { slept, sleep: async (ms: number) => { slept.push(ms); } }; };
const quiet = () => {};

describe("runLoop", () => {
  it("loop claims, runs the handler, completes with its result", async () => {
    const f = fakeApi([job("j1")]);
    const s = sleeper();
    const seen: { id: string; workDir: string }[] = [];
    const h: JobHandler = { kind: "voice.segment", async run(ctx) { seen.push({ id: ctx.job.id, workDir: ctx.workDir }); return { key: "k", durationMs: 900 }; } };
    await runLoop({ api: f.api, handlers: [h], cfg: cfg(), sleep: s.sleep, once: true, log: quiet });
    expect(seen.map((x) => x.id)).toEqual(["j1"]);
    expect(f.completes).toEqual([{ id: "j1", result: { key: "k", durationMs: 900 } }]);
    expect(f.fails).toEqual([]);
    expect(f.claims[0]).toEqual(["voice.segment"]);
  });

  it("a handler throw reports fail and the loop continues", async () => {
    const f = fakeApi([job("bad"), job("good")]);
    const h: JobHandler = { kind: "voice.segment", async run(ctx) { if (ctx.job.id === "bad") throw new Error("the engine fell over"); return { ok: 1 }; } };
    await expect(runLoop({ api: f.api, handlers: [h], cfg: cfg(), sleep: sleeper().sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(f.fails).toEqual([{ id: "bad", error: "the engine fell over" }]);
    expect(f.completes).toEqual([{ id: "good", result: { ok: 1 } }]);
  });

  it("a 401 stops the loop with the revoked message", async () => {
    const f = fakeApi([new TokenRevoked()]);
    const e = await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return {}; } }], cfg: cfg(), sleep: sleeper().sleep, log: quiet }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(TokenRevoked);
    expect((e as Error).message).toMatch(/revoked/i);
  });

  it("a 401 while a job runs stops the loop too, without trying to report a failure", async () => {
    const f = fakeApi([job("j1"), job("never")]);
    const h: JobHandler = { kind: "voice.segment", async run() { throw new TokenRevoked(); } };
    await expect(runLoop({ api: f.api, handlers: [h], cfg: cfg(), sleep: sleeper().sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(f.fails).toEqual([]);
  });

  it("two idle polls sleep pollSeconds twice", async () => {
    const f = fakeApi([null, null]);
    const s = sleeper();
    await expect(runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return {}; } }], cfg: cfg(), sleep: s.sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(s.slept).toEqual([5000, 5000]);
  });

  it("once with nothing waiting returns without sleeping", async () => {
    const f = fakeApi([null]);
    const s = sleeper();
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return {}; } }], cfg: cfg(), sleep: s.sleep, once: true, log: quiet });
    expect(s.slept).toEqual([]);
    expect(f.claims.length).toBe(1);
  });

  it("once does one job and stops", async () => {
    const f = fakeApi([job("a"), job("b")]);
    const ran: string[] = [];
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run(c) { ran.push(c.job.id); return {}; } }], cfg: cfg(), sleep: sleeper().sleep, once: true, log: quiet });
    expect(ran).toEqual(["a"]);
  });

  it("work dir is removed after success and after failure", async () => {
    const f = fakeApi([job("ok"), job("boom")]);
    const dirs: { id: string; dir: string; existedDuring: boolean }[] = [];
    const h: JobHandler = { kind: "voice.segment", async run(ctx) {
      dirs.push({ id: ctx.job.id, dir: ctx.workDir, existedDuring: existsSync(ctx.workDir) });
      if (ctx.job.id === "boom") throw new Error("nope");
      return {};
    } };
    await expect(runLoop({ api: f.api, handlers: [h], cfg: cfg(), sleep: sleeper().sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(dirs.length).toBe(2);
    for (const d of dirs) { expect(d.existedDuring).toBe(true); expect(existsSync(d.dir)).toBe(false); }
    expect(dirs[0].dir).not.toBe(dirs[1].dir);
  });

  it("a job of a kind it has no handler for is failed, not dropped", async () => {
    const f = fakeApi([job("x", "render")]);
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return {}; } }], cfg: cfg(), sleep: sleeper().sleep, once: true, log: quiet });
    expect(f.fails.length).toBe(1);
    expect(f.fails[0].error).toMatch(/render/);
  });

  it("a claim that fails for any other reason is retried after a pause, and the loop goes on", async () => {
    const f = fakeApi([new Error("fetch failed"), new ApiError(503, "unavailable"), job("j1")]);
    const s = sleeper();
    const ran: string[] = [];
    await expect(runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run(c) { ran.push(c.job.id); return {}; } }], cfg: cfg(), sleep: s.sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(ran).toEqual(["j1"]);
    expect(s.slept).toEqual([5000, 10000]);
  });

  it("an empty error message still gives the server a reason", async () => {
    const f = fakeApi([job("j1")]);
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { throw new Error(""); } }], cfg: cfg(), sleep: sleeper().sleep, once: true, log: quiet });
    expect(f.fails[0].error.length).toBeGreaterThan(0);
  });

  it("a result the server will not take is reported as a failure; one already done is not", async () => {
    const f = fakeApi([job("refused"), job("late")]);
    const origComplete = f.api.complete;
    f.api.complete = async (id, r) => {
      if (id === "refused") throw new ApiError(422, "the voice file was never uploaded");
      if (id === "late") throw new ApiError(409, "already done");
      return origComplete(id, r);
    };
    await expect(runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return {}; } }], cfg: cfg(), sleep: sleeper().sleep, log: quiet })).rejects.toBeInstanceOf(TokenRevoked);
    expect(f.fails).toEqual([{ id: "refused", error: "the voice file was never uploaded" }]);
  });

  it("a network blip while completing is retried before giving up", async () => {
    const f = fakeApi([job("j1")]);
    let n = 0;
    const origComplete = f.api.complete;
    f.api.complete = async (id, r) => { if (++n < 3) throw new TypeError("fetch failed"); return origComplete(id, r); };
    const s = sleeper();
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run() { return { ok: 1 }; } }], cfg: cfg(), sleep: s.sleep, once: true, log: quiet });
    expect(f.completes).toEqual([{ id: "j1", result: { ok: 1 } }]);
    expect(f.fails).toEqual([]);
    expect(s.slept.length).toBe(2);
  });

  it("stops between jobs when asked to", async () => {
    const f = fakeApi([job("a"), job("b")]);
    const ac = new AbortController();
    const ran: string[] = [];
    await runLoop({ api: f.api, handlers: [{ kind: "voice.segment", async run(c) { ran.push(c.job.id); ac.abort(); return {}; } }], cfg: cfg(), sleep: sleeper().sleep, signal: ac.signal, log: quiet });
    expect(ran).toEqual(["a"]);
    expect(f.completes.length).toBe(1);
  });
});
