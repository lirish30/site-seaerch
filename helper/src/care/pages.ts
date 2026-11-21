import { stat } from "node:fs/promises";
import type { Exec } from "../exec.ts";
import { WP_ARG } from "./wp.ts";

/** How a page compares before and after an update (Call 11). */
export type Verdict = "ok" | "changed" | "broken";

export interface PageShot { path: string; status: number | null; fatal: boolean; forms: number; png: string | null }

const MAX_BODY = 2 * 1024 * 1024;
const FATAL_TEXT = "There has been a critical error on this website";

/**
 * One GET (20 s, redirects followed, `cache-control: no-cache` and `pragma: no-cache`). Reads at most 2 MB of the body, then stops. A request that fails or times out before the headers arrive gives `status: null`.
 * Once the headers have arrived the status is kept for good: a body that stalls or breaks off counts as an empty body (not fatal, no forms), never as an unreachable page.
 */
export async function readPage(fetchFn: typeof fetch, url: string): Promise<{ status: number | null; fatal: boolean; forms: number }> {
  let res: Response;
  try {
    // No cache in between may answer for the site: a cached 200 would hide a page the update broke.
    res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  } catch {
    return { status: null, fatal: false, forms: 0 };
  }
  let html = "";
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let got = 0;
      try {
        while (got < MAX_BODY) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          html += dec.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
  } catch {
    html = "";
  }
  return { status: res.status, fatal: html.includes(FATAL_TEXT), forms: (html.match(/<form/gi) ?? []).length };
}

/** Headless Chrome screenshot of `url` into `outPng`. The URL is the last argv element (no shell). False on any failure, and when Chrome exits 0 without writing the file. */
export async function screenshot(exec: Exec, chrome: string, url: string, outPng: string): Promise<boolean> {
  try {
    await exec(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--window-size=1280,1600",
      "--virtual-time-budget=8000", `--screenshot=${outPng}`, url,
    ], { timeoutMs: 60_000 });
    const s = await stat(outPng);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** SSIM of two screenshots (the `All:` value ffmpeg prints on stderr) and a contrast-boosted difference image. Null when either step fails. */
export async function compare(exec: Exec, ffmpeg: string, a: string, b: string, diffJpg: string): Promise<number | null> {
  try {
    const r = await exec(ffmpeg, ["-hide_banner", "-nostats", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], { timeoutMs: 60_000 });
    const m = /All:([0-9.]+)/.exec(`${r.stderr ?? ""}\n${r.stdout}`);
    if (!m) return null;
    const ssim = Number(m[1]);
    if (!Number.isFinite(ssim)) return null;
    await exec(ffmpeg, ["-y", "-hide_banner", "-i", a, "-i", b, "-lavfi", "blend=all_mode=difference,eq=contrast=3", "-frames:v", "1", "-q:v", "5", diffJpg], { timeoutMs: 60_000 });
    return ssim;
  } catch {
    return null;
  }
}

/** PNG to JPEG, one frame. False on failure. */
export async function toJpeg(exec: Exec, ffmpeg: string, png: string, jpg: string): Promise<boolean> {
  try {
    await exec(ffmpeg, ["-y", "-hide_banner", "-i", png, "-frames:v", "1", "-q:v", "5", jpg], { timeoutMs: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/** Call 11. Broken: a 2xx page now null/404/410/5xx, the critical-error text, or fewer forms. Changed: SSIM under 0.95. A page that was not 2xx before is never broken on status. */
export function verdictOf(before: PageShot, after: PageShot, ssim: number | null): Verdict {
  const was2xx = before.status !== null && before.status >= 200 && before.status < 300;
  const statusBroke = was2xx && (after.status === null || after.status === 404 || after.status === 410 || after.status >= 500);
  if (statusBroke || after.fatal || after.forms < before.forms) return "broken";
  if (ssim !== null && ssim < 0.95) return "changed";
  return "ok";
}

/** The site's origin plus a checked path, never another host. */
export function pageUrl(siteUrl: string, path: string): string {
  if (!WP_ARG.checkPath.test(path)) throw new Error("this page path is not valid");
  const origin = new URL(siteUrl).origin;
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("this page path is not valid");
  return url.href;
}

/** Which read of a page this is: each one gets its own URL. */
export type CheckTag = "before" | "after" | "recheck";

/**
 * `pageUrl` (same origin, checked path) plus `siteline-check=<runId>-<attempt>-<i>-<tag>`, so WP Rocket, a host's Varnish or Cloudflare cannot answer from a copy cached before the update,
 * and a retried job never asks for an address an earlier attempt already put in a cache.
 * The query is added after pageUrl's checks, with `&` when the path already has one.
 */
export function checkUrl(siteUrl: string, path: string, runId: string, attempt: number, i: number, tag: CheckTag): string {
  const url = pageUrl(siteUrl, path);
  return `${url}${url.includes("?") ? "&" : "?"}siteline-check=${encodeURIComponent(`${runId}-${attempt}-${i}-${tag}`)}`;
}
