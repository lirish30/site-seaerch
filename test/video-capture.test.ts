import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { PAGE_HEIGHT_SCRIPT, captureShots, type BrowserLike, type CapturePage } from "../src/worker/video/capture";
import { BLOCK_PROBE } from "../src/worker/render/render";

interface Call { kind: "screenshot"; width: number; clip: { x: number; y: number; width: number; height: number; scale?: number }; quality: number }

/** A browser that never leaves the test: it reports a page height per viewport and returns bytes whose size depends on the quality asked for. */
function fakeBrowser(o: { desktopHeight?: number; mobileHeight?: number; bytesAt?: (quality: number, scale: number) => number; blockedDesktop?: boolean; failMobile?: boolean } = {}) {
  const calls: Call[] = [];
  const visited: string[] = [];
  let width = 0;
  const page: CapturePage = {
    async setViewport(v) { width = v.width; },
    async setUserAgent() {},
    async goto(url) {
      if (o.failMobile && width < 600) throw new Error("mobile load failed");
      visited.push(`${width}:${url}`);
    },
    async evaluate(script: string) {
      if (script === PAGE_HEIGHT_SCRIPT) return (width < 600 ? o.mobileHeight ?? 5000 : o.desktopHeight ?? 6000) as never;
      if (script === BLOCK_PROBE) return (o.blockedDesktop && width >= 600) as never;
      throw new Error(`unexpected script: ${script}`);
    },
    async screenshot(s) {
      calls.push({ kind: "screenshot", width, clip: s.clip!, quality: s.quality });
      const n = o.bytesAt ? o.bytesAt(s.quality, s.clip?.scale ?? 1) : 100;
      return new Uint8Array(n).fill(7);
    },
  };
  const browser: BrowserLike = { newPage: async () => page, close: async () => {} };
  return { browser, calls, visited };
}

describe("captureShots", () => {
  it("stores full and preview for every shot", async () => {
    const { browser, calls, visited } = fakeBrowser();
    const shots = await captureShots(env, "vid-1", "https://ace.com/", { browser });
    expect(shots.map((s) => s.id)).toEqual(["d1", "d2", "d3", "d4", "m1", "m2"]);
    expect(shots.map((s) => s.viewport)).toEqual(["desktop", "desktop", "desktop", "desktop", "mobile", "mobile"]);
    expect(visited).toEqual(["1280:https://ace.com/", "390:https://ace.com/"]);
    for (const s of shots) {
      expect(s.fullKey).toBe(`video/vid-1/shots/${s.id}.jpg`);
      expect(s.previewKey).toBe(`video/vid-1/shots/${s.id}.preview.jpg`);
      for (const k of [s.fullKey, s.previewKey]) {
        const o = await env.RAW.get(k);
        expect(o, k).not.toBeNull();
        expect(o!.httpMetadata?.contentType).toBe("image/jpeg");
      }
    }
    expect(shots[0]).toMatchObject({ viewport: "desktop", scrollY: 0, width: 1280, height: 720 });
    expect(shots[4]).toMatchObject({ viewport: "mobile", scrollY: 0, width: 390, height: 844 });
    // Slices run down the page, the last one ending at its bottom edge.
    const ys = shots.filter((s) => s.viewport === "desktop").map((s) => s.scrollY);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[ys.length - 1]).toBe(6000 - 720);
    // Full images at quality 85; previews at 1000 px wide (desktop) and quality 70.
    const full = calls.filter((c) => c.quality === 85), prev = calls.filter((c) => c.quality === 70);
    expect(full).toHaveLength(6);
    expect(prev).toHaveLength(6);
    expect(prev.filter((c) => c.width === 1280).every((c) => Math.abs(c.clip.scale! - 1000 / 1280) < 1e-9)).toBe(true);
    expect(prev.filter((c) => c.width === 390).every((c) => (c.clip.scale ?? 1) <= 1)).toBe(true);
  });

  it("a page shorter than a screen yields one desktop slice", async () => {
    const { browser } = fakeBrowser({ desktopHeight: 500, mobileHeight: 500 });
    const shots = await captureShots(env, "vid-2", "https://ace.com/", { browser });
    expect(shots.filter((s) => s.viewport === "desktop")).toHaveLength(1);
    expect(shots.filter((s) => s.viewport === "mobile")).toHaveLength(1);
    expect(shots[0]).toMatchObject({ id: "d1", scrollY: 0, height: 500 });
  });

  it("preview is under 1 MB", async () => {
    // At quality 70 the fake returns 1.4 MB; lower qualities fit.
    const { browser } = fakeBrowser({ bytesAt: (q) => (q >= 70 ? 1_400_000 : 600_000) });
    const shots = await captureShots(env, "vid-3", "https://ace.com/", { browser });
    for (const s of shots) {
      const p = await env.RAW.get(s.previewKey);
      expect(p!.size).toBeLessThan(1_048_576);
      expect(p!.size).toBeGreaterThan(0);
    }
  });

  it("fails when the desktop view is a bot-block page", async () => {
    const { browser } = fakeBrowser({ blockedDesktop: true });
    await expect(captureShots(env, "vid-4", "https://ace.com/", { browser })).rejects.toThrow(/blocked/i);
  });

  it("keeps the desktop shots when the phone view can't be loaded", async () => {
    const { browser } = fakeBrowser({ failMobile: true });
    const shots = await captureShots(env, "vid-5", "https://ace.com/", { browser });
    expect(shots.map((s) => s.id)).toEqual(["d1", "d2", "d3", "d4"]);
  });

  it("fails clearly when Browser Rendering isn't configured", async () => {
    const noBrowser = { ...env, BROWSER: undefined } as typeof env;
    await expect(captureShots(noBrowser, "vid-6", "https://ace.com/")).rejects.toThrow(/Browser Rendering/);
  });
});
