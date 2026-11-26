/**
 * The Siteline look, for the pages the helper renders (the report video). A copy of the tokens in `src/worker/brand/siteline.ts` (Figma "Siteline · Homepage / 1440 · v6", 69:1988): the helper is plain Node
 * with no build step, and that module imports its font file without an extension, which Node cannot resolve, so the few values and the flow-line drawing are repeated here. Change a colour in one place, change it in both.
 * The fonts are the one thing shared, not copied: the base64 Geist files live in `src/worker/brand/fontData.ts` (plain strings, imported with its extension), and the helper runs from the repo checkout (its launchd plist holds the repo path).
 */
import { GEIST_MONO_WOFF2_BASE64, GEIST_SANS_WOFF2_BASE64 } from "../../../src/worker/brand/fontData.ts";

export const SL = {
  paper: "#f4f5ef",
  ink: "#07090a",
  night: "#0c0f0e",
  muted: "#59625d",
  mutedOnNight: "#a9b2ad",
  mint: "#00e5a0",
  green: "#0a7a55",
  sans: `"Geist",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif`,
  mono: `"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace`,
} as const;

/** Geist and Geist Mono as embedded `@font-face` (no font request of the page's own). Whether HyperFrames' compiler keeps these or swaps in its own web font is not known: see the README. */
export const FONT_FACE_CSS =
  `@font-face{font-family:"Geist";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${GEIST_SANS_WOFF2_BASE64}) format("woff2")}` +
  `@font-face{font-family:"Geist Mono";font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${GEIST_MONO_WOFF2_BASE64}) format("woff2")}`;

/** A bundle of thin lines narrowing to one mint line (the homepage's closing graphic). `dir` is the side it opens from; the thin lines take `currentColor`. */
export function flowLinesSvg(o: { width: number; height: number; dir: "left" | "right"; lines?: number; opacity?: number }): string {
  const n = Math.max(3, o.lines ?? 11);
  const { width: w, height: h } = o;
  const mid = h / 2;
  const x = (v: number): number => (o.dir === "left" ? v : w - v);
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = (h * (i + 0.5)) / n;
    if (Math.abs(y - mid) < h / n / 2) continue;
    paths.push(`<path d="M${x(0)} ${y.toFixed(1)}C${x(w * 0.55).toFixed(1)} ${y.toFixed(1)} ${x(w * 0.6).toFixed(1)} ${mid} ${x(w)} ${mid}"/>`);
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.5" opacity="${o.opacity ?? 0.3}">${paths.join("")}</g>` +
    `<path d="M${x(0)} ${mid}H${x(w)}" stroke="${SL.mint}" stroke-width="2"/></svg>`;
}
