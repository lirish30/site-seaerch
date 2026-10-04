import { CRO_LIMITS } from "./config";
import type { Crop, Evidence } from "./types";

const SHOT_WIDTH = { desktop: 1440, mobile: 390 } as const;
const PAD = 40;

const MIN_WINDOW = 320;
const num = (v: number) => (Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * CSS numbers to show one element of a full-page screenshot, padded, scaled to displayWidth, with a pin at its centre.
 * Always returns finite numbers: the window stays inside the shot (and at least MIN_WINDOW wide), and the pin is clamped
 * to the visible box when the element is taller than maxHeight or lies at/beyond the shot edge.
 */
export function cropView(c: Pick<Crop, "x" | "y" | "w" | "h" | "device">, displayWidth: number, maxHeight = 440) {
  const shotW = Math.max(1, SHOT_WIDTH[c.device] ?? SHOT_WIDTH.desktop);
  const minW = Math.min(MIN_WINDOW, shotW);
  const x = num(c.x), y = num(c.y), w = Math.max(0, num(c.w)), h = Math.max(0, num(c.h));
  const dw = Math.max(1, num(displayWidth));
  const cx = clamp(x - PAD, 0, shotW - minW), cy = Math.max(0, y - PAD);
  const cw = Math.max(minW, Math.min(shotW - cx, w + PAD * 2));
  const scale = dw / cw;
  const ch = Math.max(1, Math.min(h + PAD * 2, Math.floor(maxHeight / scale)));
  const height = Math.max(1, Math.round(ch * scale));
  return {
    width: dw, height, bgWidth: Math.round(shotW * scale),
    bgX: -Math.round(cx * scale), bgY: -Math.round(cy * scale),
    markerX: clamp(Math.round((x + w / 2 - cx) * scale), 0, dw), markerY: clamp(Math.round((y + h / 2 - cy) * scale), 0, height),
  };
}

export function itemCrop(item: { evidence_ids: string[] }, evidence: Evidence[]): Crop | null {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  // Full-page shots are clipped at shotMaxHeight, so an element that starts below it has nothing to show.
  for (const id of item.evidence_ids) { const c = byId.get(id)?.crop; if (c && num(c.y) < CRO_LIMITS.shotMaxHeight) return c; }
  return null;
}
