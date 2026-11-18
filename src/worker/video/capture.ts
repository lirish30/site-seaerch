import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env";
import { BLOCK_PROBE, MOBILE_UA } from "../render/render";
import type { Shot } from "./plan";

/**
 * The screenshots a video is made from. The video frame is 16:9, so a desktop shot is a 1280x720 slice of the page; a phone shot is one 390x844 screen.
 * Each shot is stored twice: the full image (JPEG, quality 85) for the render, and a smaller preview (at most 1 MB) for the editor and for Claude.
 */
export const DESKTOP_SLICE = { width: 1280, height: 720 } as const;
export const MOBILE_SCREEN = { width: 390, height: 844 } as const;
export const MAX_DESKTOP_SHOTS = 4;
export const MAX_MOBILE_SHOTS = 2;
export const FULL_QUALITY = 85;
export const PREVIEW = { width: 1000, quality: 70, maxBytes: 1_048_576 } as const;
/** Lower qualities tried, in order, when a preview comes out over the limit. */
const PREVIEW_FALLBACK_QUALITIES = [55, 40, 25] as const;
const NAV_TIMEOUT_MS = 25_000;
/** A page this tall is cut off here: nothing past it is ever worth a slice. */
const MAX_PAGE_HEIGHT = 30_000;

/** Runs in the page: how tall the whole document is. */
export const PAGE_HEIGHT_SCRIPT = "document.documentElement.scrollHeight";

/** The part of a browser page the capture uses. A puppeteer page fits it; tests pass a fake. */
export interface CapturePage {
  setViewport(v: { width: number; height: number; isMobile?: boolean; hasTouch?: boolean; deviceScaleFactor?: number }): Promise<void>;
  setUserAgent(ua: string): Promise<void>;
  goto(url: string, o: { waitUntil: "networkidle2"; timeout: number }): Promise<unknown>;
  evaluate<T = unknown>(script: string): Promise<T>;
  screenshot(o: { type: "jpeg"; quality: number; captureBeyondViewport: boolean; clip: { x: number; y: number; width: number; height: number; scale?: number } }): Promise<Uint8Array>;
}
export interface BrowserLike { newPage(): Promise<CapturePage>; close(): Promise<void> }

/** Where the first slice of a page starts and the rest follow: spread evenly down the page, the last ending at its bottom edge. */
export function sliceOffsets(pageHeight: number, sliceHeight: number, max: number): number[] {
  const n = Math.max(1, Math.min(max, Math.ceil(pageHeight / sliceHeight)));
  if (n === 1) return [0];
  const step = (pageHeight - sliceHeight) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(i * step));
}

type View = { viewport: Shot["viewport"]; width: number; height: number; prefix: string; max: number };

async function takeShots(page: CapturePage, raw: R2Bucket, videoId: string, v: View): Promise<Shot[]> {
  const pageHeight = Math.min(Number(await page.evaluate<number>(PAGE_HEIGHT_SCRIPT)) || v.height, MAX_PAGE_HEIGHT);
  const height = Math.max(1, Math.min(v.height, Math.floor(pageHeight)));
  const shots: Shot[] = [];
  const jpg = { httpMetadata: { contentType: "image/jpeg" } };
  const offsets = sliceOffsets(pageHeight, height, v.max);
  for (let i = 0; i < offsets.length; i++) {
    const id = `${v.prefix}${i + 1}`;
    const scrollY = offsets[i];
    const clip = { x: 0, y: scrollY, width: v.width, height };
    const shot = (quality: number, scale?: number) => page.screenshot({ type: "jpeg", quality, captureBeyondViewport: true, clip: scale ? { ...clip, scale } : clip });
    const fullKey = `video/${videoId}/shots/${id}.jpg`;
    const previewKey = `video/${videoId}/shots/${id}.preview.jpg`;
    await raw.put(fullKey, await shot(FULL_QUALITY), jpg);

    // Never upscale a phone screen to the preview width.
    const scale = Math.min(1, PREVIEW.width / v.width);
    let preview = await shot(PREVIEW.quality, scale);
    for (const q of PREVIEW_FALLBACK_QUALITIES) {
      if (preview.byteLength < PREVIEW.maxBytes) break;
      preview = await shot(q, scale);
    }
    if (preview.byteLength >= PREVIEW.maxBytes) throw new Error(`The preview of screenshot ${id} is over 1 MB even at low quality`);
    await raw.put(previewKey, preview, jpg);
    shots.push({ id, viewport: v.viewport, scrollY, width: v.width, height, fullKey, previewKey });
  }
  return shots;
}

/**
 * Captures up to 4 desktop slices (d1..d4) and 2 phone screens (m1..m2) of one page and stores them under `video/<videoId>/shots/`.
 * The desktop view is required (a blocked or unreachable site throws); the phone view is best effort. `deps.browser` is for tests; otherwise Browser Rendering is used.
 */
export async function captureShots(env: Env, videoId: string, url: string, deps: { browser?: BrowserLike } = {}): Promise<Shot[]> {
  let browser = deps.browser;
  if (!browser) {
    if (!env.BROWSER) throw new Error("Browser Rendering isn't configured, so screenshots can't be taken");
    browser = (await puppeteer.launch(env.BROWSER)) as unknown as BrowserLike;
  }
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...DESKTOP_SLICE });
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    if (await page.evaluate<boolean>(BLOCK_PROBE)) throw new Error("The site blocked our browser, so it can't be screenshotted");
    const desktop = await takeShots(page, env.RAW, videoId, { viewport: "desktop", ...DESKTOP_SLICE, prefix: "d", max: MAX_DESKTOP_SHOTS });

    // The phone view is best effort: if it fails or is blocked, the desktop shots are enough to make a video.
    let mobile: Shot[] = [];
    try {
      await page.setUserAgent(MOBILE_UA);
      await page.setViewport({ ...MOBILE_SCREEN, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      if (!(await page.evaluate<boolean>(BLOCK_PROBE))) {
        mobile = await takeShots(page, env.RAW, videoId, { viewport: "mobile", ...MOBILE_SCREEN, prefix: "m", max: MAX_MOBILE_SHOTS });
      }
    } catch { mobile = []; }
    return [...desktop, ...mobile];
  } finally {
    await browser.close();
  }
}
