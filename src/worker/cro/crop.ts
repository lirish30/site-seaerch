import type { Crop, Evidence } from "./types";

const SHOT_WIDTH = { desktop: 1440, mobile: 390 } as const;
const PAD = 40;

/** CSS numbers to show one element of a full-page screenshot, padded, scaled to displayWidth, with a pin at its centre. */
export function cropView(c: Pick<Crop, "x" | "y" | "w" | "h" | "device">, displayWidth: number, maxHeight = 440) {
  const shotW = SHOT_WIDTH[c.device];
  const cx = Math.max(0, c.x - PAD), cy = Math.max(0, c.y - PAD);
  const cw = Math.min(shotW - cx, Math.max(c.w + PAD * 2, 320));
  const scale = displayWidth / cw;
  const ch = Math.min(c.h + PAD * 2, Math.floor(maxHeight / scale));
  return {
    width: displayWidth, height: Math.round(ch * scale), bgWidth: Math.round(shotW * scale),
    bgX: -Math.round(cx * scale), bgY: -Math.round(cy * scale),
    markerX: Math.round((c.x + c.w / 2 - cx) * scale), markerY: Math.round((c.y + c.h / 2 - cy) * scale),
  };
}

export function itemCrop(item: { evidence_ids: string[] }, evidence: Evidence[]): Crop | null {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  for (const id of item.evidence_ids) { const c = byId.get(id)?.crop; if (c) return c; }
  return null;
}
