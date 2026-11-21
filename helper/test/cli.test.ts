import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";

const TOKEN = "hlp_" + "z".repeat(43);
let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "helper-cli-")); path = join(dir, "config.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hello = () => new Response(JSON.stringify({ serverTime: "2026-11-18T00:00:00.000Z", minHelperVersion: "0.1.0" }), { status: 200 });
function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}

describe("pair", () => {
  it("writes the config, checks the token with the server, and never prints it", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => { seen.push(String(url)); return hello(); }) as unknown as typeof fetch;
    const t = io();
    expect(await main(["pair", "https://agency.example.com", TOKEN], { configPath: path, fetch: fetchImpl, ...t.deps })).toBe(0);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toEqual({ apiBase: "https://agency.example.com", token: TOKEN });
    expect(seen).toEqual(["https://agency.example.com/helper/hello"]);
    expect([...t.out, ...t.err].join("\n")).not.toContain(TOKEN);
  });

  it("reads the token from stdin when given -", async () => {
    const t = io();
    const code = await main(["pair", "https://agency.example.com", "-"], { configPath: path, fetch: (async () => hello()) as unknown as typeof fetch, readStdin: async () => `${TOKEN}\n`, ...t.deps });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(TOKEN);
  });

  it("says so when the server does not accept the token, still without printing it", async () => {
    const t = io();
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await main(["pair", "https://agency.example.com", TOKEN], { configPath: path, fetch: fetchImpl, ...t.deps })).toBe(1);
    expect(t.err.join("\n")).toMatch(/did not accept/);
    expect([...t.out, ...t.err].join("\n")).not.toContain(TOKEN);
  });

  it("refuses a bad token before writing anything", async () => {
    const t = io();
    expect(await main(["pair", "https://agency.example.com", "nope"], { configPath: path, ...t.deps })).toBe(1);
    expect(() => readFileSync(path)).toThrow();
    expect(t.err.join("\n")).toMatch(/token/);
  });
});

describe("run and once", () => {
  const cfgFile = () => writeFileSync(path, JSON.stringify({ apiBase: "https://agency.example.com", token: TOKEN, cacheDir: join(dir, "cache") }));

  it("once with a revoked token stops with the revoked message and a failing exit code", async () => {
    cfgFile();
    const t = io();
    const code = await main(["once"], { configPath: path, fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch, ...t.deps });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toMatch(/revoked/i);
  });

  it("run with a revoked token exits 0 so launchd does not restart it forever", async () => {
    cfgFile();
    const t = io();
    const code = await main(["run"], { configPath: path, fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch, ...t.deps });
    expect(code).toBe(0);
    expect(t.err.join("\n")).toMatch(/revoked/i);
  });

  it("once claims only the kinds it has handlers for and exits when nothing is waiting", async () => {
    cfgFile();
    const bodies: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/hello")) return hello();
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const t = io();
    expect(await main(["once"], { configPath: path, fetch: fetchImpl, ...t.deps })).toBe(0);
    expect(bodies).toEqual([{ kinds: ["voice.segment", "voice.sample", "render", "meetily.sync", "care.inventory", "care.update"] }]);
  });

  it("names a config problem instead of crashing", async () => {
    writeFileSync(path, JSON.stringify({ apiBase: "https://agency.example.com" }));
    const t = io();
    expect(await main(["run"], { configPath: path, ...t.deps })).toBe(1);
    expect(t.err.join("\n")).toMatch(/token/);
  });
});

describe("doctor", () => {
  it("lists every engine and tool, and exits 1 when something needed is missing", async () => {
    writeFileSync(path, JSON.stringify({ apiBase: "https://agency.example.com", token: TOKEN, ffmpeg: join(dir, "no-ffmpeg"), ffprobe: join(dir, "no-ffprobe"), hyperframes: join(dir, "no-hf"), python: { "qwen3-tts": join(dir, "q"), chatterbox: join(dir, "c"), "openvoice-v2": join(dir, "o") } }));
    const t = io();
    const code = await main(["doctor"], { configPath: path, fetch: (async () => hello()) as unknown as typeof fetch, ...t.deps });
    const text = t.out.join("\n");
    expect(code).toBe(1);
    for (const id of ["qwen3-tts", "chatterbox", "openvoice-v2", "ffmpeg", "ffprobe", "hyperframes"]) expect(text).toContain(id);
    expect(text).toMatch(/NOT available/);
    expect(text).toMatch(/NOT FOUND/);
    expect(text).not.toContain(TOKEN);
  });

  it("an unknown command prints the usage and exits 2", async () => {
    const t = io();
    expect(await main(["wat"], t.deps)).toBe(2);
    expect(t.err.join("\n")).toMatch(/pair <apiBase> <token>/);
  });
});
