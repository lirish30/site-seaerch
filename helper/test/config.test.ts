import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, writePairing } from "../src/config.ts";

const TOKEN = "hlp_" + "a".repeat(43);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "helper-config-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.SITELINE_HELPER_CONFIG; });
const put = (v: unknown) => { const p = join(dir, "config.json"); writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v)); return p; };

describe("loadConfig", () => {
  it("fills every default from just the two required fields", () => {
    const c = loadConfig(put({ apiBase: "https://agency.example.com/", token: TOKEN }));
    expect(c.apiBase).toBe("https://agency.example.com");
    expect(c.token).toBe(TOKEN);
    expect(c.pollSeconds).toBe(5);
    expect(c.ffmpeg).toBe("ffmpeg");
    expect(c.ffprobe).toBe("ffprobe");
    expect(c.hyperframes).toBe("hyperframes");
    expect(c.python["chatterbox"]).toMatch(/venvs\/chatterbox\/bin\/python$/);
    expect(Object.keys(c.python).sort()).toEqual(["chatterbox", "openvoice-v2", "qwen3-tts"]);
    expect(c.cacheDir).toMatch(/\.siteline-helper\/cache$/);
  });

  it("config naming a missing field says which", () => {
    expect(() => loadConfig(put({ token: TOKEN }))).toThrow(/apiBase/);
    expect(() => loadConfig(put({ apiBase: "https://x.example.com" }))).toThrow(/token/);
  });

  it("names the bad field and what was wrong with it", () => {
    expect(() => loadConfig(put({ apiBase: "not a url", token: TOKEN }))).toThrow(/apiBase/);
    expect(() => loadConfig(put({ apiBase: "http://agency.example.com", token: TOKEN }))).toThrow(/apiBase.*https/);
    expect(() => loadConfig(put({ apiBase: "https://x.example.com", token: "nope" }))).toThrow(/token/);
    expect(() => loadConfig(put({ apiBase: "https://x.example.com", token: TOKEN, pollSeconds: 0 }))).toThrow(/pollSeconds/);
    expect(() => loadConfig(put({ apiBase: "https://x.example.com", token: TOKEN, python: { chatterbox: 4 } }))).toThrow(/python\.chatterbox/);
    expect(() => loadConfig(put({ apiBase: "https://x.example.com", token: TOKEN, ffmpeg: "" }))).toThrow(/ffmpeg/);
  });

  it("allows plain http only for a local server", () => {
    expect(loadConfig(put({ apiBase: "http://localhost:8787", token: TOKEN })).apiBase).toBe("http://localhost:8787");
    expect(loadConfig(put({ apiBase: "http://127.0.0.1:8787/", token: TOKEN })).apiBase).toBe("http://127.0.0.1:8787");
  });

  it("explains what to do when there is no file or it is not JSON, without printing the token", () => {
    expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/pair/);
    const p = put("{ not json " + TOKEN);
    try { loadConfig(p); throw new Error("should have thrown"); } catch (e) { expect((e as Error).message).toMatch(/JSON/); expect((e as Error).message).not.toContain(TOKEN); }
  });

  it("takes the path from SITELINE_HELPER_CONFIG when none is given", () => {
    const p = put({ apiBase: "https://x.example.com", token: TOKEN, pollSeconds: 9 });
    process.env.SITELINE_HELPER_CONFIG = p;
    expect(configPath()).toBe(p);
    expect(loadConfig().pollSeconds).toBe(9);
  });
});

describe("writePairing", () => {
  it("writes the file readable by its owner only and the result loads", () => {
    const p = join(dir, "sub", "config.json");
    writePairing("https://agency.example.com/", TOKEN, p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadConfig(p).token).toBe(TOKEN);
  });

  it("keeps the other settings when pairing again", () => {
    const p = put({ apiBase: "https://old.example.com", token: TOKEN, pollSeconds: 12, ffmpeg: "/opt/ffmpeg" });
    writePairing("https://new.example.com", "hlp_" + "b".repeat(43), p);
    const c = loadConfig(p);
    expect(c.apiBase).toBe("https://new.example.com");
    expect(c.token).toBe("hlp_" + "b".repeat(43));
    expect(c.pollSeconds).toBe(12);
    expect(c.ffmpeg).toBe("/opt/ffmpeg");
    expect(readFileSync(p, "utf8")).not.toContain("old.example.com");
  });

  it("refuses a token or base that would never load", () => {
    expect(() => writePairing("https://x.example.com", "nope", join(dir, "c.json"))).toThrow(/token/);
    expect(() => writePairing("ftp://x", TOKEN, join(dir, "c.json"))).toThrow(/apiBase/);
  });
});
