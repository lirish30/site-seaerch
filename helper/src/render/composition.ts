/**
 * The video as a HyperFrames project: one HTML page whose timeline (GSAP, paused, driven by the renderer frame by frame) shows each script line over its
 * screenshot, moves the camera to what the line is about, draws the owner's markups and plays the line's audio. Pure and deterministic: the same plan
 * and lengths always give the same text, and nothing here reads the clock, the disk or the network.
 *
 * Verified against hyperframes 0.9.69 (see docs/superpowers/notes/2026-11-hyperframes.md): a project is an `index.html` with `data-start` / `data-duration`
 * timed elements, `<audio data-start>` for sound and a timeline registered on `window.__timelines["main"]`. The page refers to images and audio by
 * relative path under `assets/` (`shotFile` and `audioFile` say which); the caller puts those files there.
 */

export const FRAME_W = 1280;
export const FRAME_H = 720;
/** Silence after each line, before the next scene (or the end card). */
export const GAP_MS = 350;
export const END_CARD_MS = 4000;
/** The camera takes this long to settle on what a line is about. */
export const CAMERA_MS = 600;
/** The first markup of a scene appears this long after the scene starts; each next one a little later, in the order the owner drew them. */
export const MARKUP_AT_MS = 400;
export const MARKUP_STAGGER_MS = 250;
const FADE_MS = 250;
/** Lines on the picture are drawn this many pixels thick, and callout text this tall, whatever the zoom: sizes are worked out in the picture's own pixels. */
const STROKE_PX = 6;
const CALLOUT_PX = 30;
const BLUR_PX = 14;
/**
 * The one script the page loads from the network: GSAP, pinned to an exact version and checked by Subresource Integrity, so a changed or tampered file is
 * refused by the browser rather than run. To change the version: fetch the new file once (`curl -sSL <url> -o gsap.min.js`), then
 * `echo "sha384-$(openssl dgst -sha384 -binary gsap.min.js | openssl base64 -A)"` and put both here (the test checks the page carries them). GSAP is not vendored.
 */
export const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js";
export const GSAP_SRI = "sha384-XmJ9SoHtVOHoQUcKvFAzVXwdkKo1Ie3bhmSoIAkcdsHGaIrVJIkmozyq0FJeb/Ly";
/** System fonts only: a render asks no web font service for anything. */
export const FONT_STACK = `-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif`;
export const RED = "#ff3b30";
export const BACKGROUND = "#0b0f19";

export type Markup =
  | { type: "circle"; x: number; y: number; r: number }
  | { type: "arrow"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "blur"; x: number; y: number; w: number; h: number }
  | { type: "callout"; x: number; y: number; text: string };

export interface RenderShot { id: string; width: number; height: number; fullKey: string }
export interface RenderSegment {
  id: string; role?: string; shotId: string; focus?: { x: number; y: number; w: number; h: number }; markups: Markup[];
  audio?: { key: string; source: "clone" | "recorded"; durationMs?: number };
}
/** The part of a video plan a render needs. A job's `plan` is this (and a little more, which is ignored). */
export interface RenderPlan { shots: RenderShot[]; segments: RenderSegment[] }
export interface Brand { name: string; business: string }

export interface CompositionInput { plan: RenderPlan; durationsMs: Record<string, number>; brand: Brand; ctaText: string }
export interface Composition { files: Record<string, string>; totalMs: number; sceneStartsMs: number[] }

const plain = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
/** Where a shot's picture goes in the project (the extension is the stored file's, so the browser reads it as what it is). */
export function shotFile(shot: Pick<RenderShot, "id" | "fullKey">): string {
  const ext = /\.(jpe?g|png|webp)$/i.exec(shot.fullKey)?.[0].toLowerCase() ?? ".jpg";
  return `assets/shot-${plain(shot.id)}${ext}`;
}
/** Where a line's narration goes in the project: always a wav, whatever it was recorded as. */
export const audioFile = (segmentId: string): string => `assets/line-${plain(segmentId)}.wav`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** A number as short text: at most 4 decimals, no trailing zeros, never "-0". */
const n = (v: number): string => { const r = Math.round(v * 1e4) / 1e4; return String(Object.is(r, -0) ? 0 : r); };
const sec = (ms: number): string => String(ms / 1000);
const c01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

interface Rect { x: number; y: number; w: number; h: number }
interface Camera { x: number; y: number; scale: number }

/** Where the picture must be moved and how big it must be for `r` (in the picture's pixels) to fill the frame. */
function cameraFor(r: Rect): Camera {
  const scale = Math.min(FRAME_W / r.w, FRAME_H / r.h);
  return { scale, x: (FRAME_W - r.w * scale) / 2 - r.x * scale, y: (FRAME_H - r.h * scale) / 2 - r.y * scale };
}
const camText = (c: Camera): string => `x: ${n(c.x)}, y: ${n(c.y)}, scale: ${n(c.scale)}`;

/** A focus box inside the picture, in its pixels; null when it is missing or too small to mean anything (then the whole picture is shown). */
function focusRect(f: RenderSegment["focus"], w: number, h: number): Rect | null {
  if (!f) return null;
  const x = c01(f.x), y = c01(f.y);
  const fw = Math.min(c01(f.w), 1 - x), fh = Math.min(c01(f.h), 1 - y);
  return fw < 0.02 || fh < 0.02 ? null : { x: x * w, y: y * h, w: fw * w, h: fh * h };
}

/** Average width of a character of the callout font (semibold sans) as a fraction of its size: deliberately on the wide side, so an estimate errs towards wrapping. */
const CHAR_EM = 0.55;
/** A callout that cannot fit on one line wraps inside this share of the picture's width. */
const WRAP_SHARE = 0.7;

export interface CalloutBox {
  /** Which side `edge` is measured from. */
  anchor: "left" | "right";
  /** Distance in picture pixels from that side of the picture to the box. */
  edge: number;
  top: number;
  /** The box's estimated width; when `wraps` it is the widest the box may be. */
  width: number;
  wraps: boolean;
}

/**
 * Where a callout goes so that all of it stays inside the picture. The width is estimated from the number of characters (`CHAR_EM` of the font size each,
 * plus the padding). It is anchored on the side its x suggests (left of x 0.55, right of it beyond), and on the other side when that is the only one with room.
 * When it fits on neither side as one line it wraps inside 70% of the picture's width and is slid in until it fits. Nothing is shortened. The vertical
 * position is kept inside the picture the same way, by the estimated number of lines.
 */
export function calloutBox(m: { x: number; y: number; text: string }, imageW: number, imageH: number, fontPx: number): CalloutBox {
  const padX = fontPx * 0.55, padY = fontPx * 0.3, border = fontPx * 0.08;
  const chrome = 2 * (padX + border);
  const lineW = Array.from(m.text).length * fontPx * CHAR_EM;
  const oneLine = lineW + chrome;
  const px = c01(m.x) * imageW, py = c01(m.y) * imageH;
  const prefer: "left" | "right" = c01(m.x) > 0.55 ? "right" : "left";
  const fits = (a: "left" | "right", w: number) => (a === "left" ? px + w <= imageW : px - w >= 0);

  let anchor: "left" | "right" = prefer;
  let width = oneLine;
  let wraps = false;
  let edge: number;
  if (fits(prefer, oneLine)) edge = prefer === "left" ? px : imageW - px;
  else if (fits(prefer === "left" ? "right" : "left", oneLine)) { anchor = prefer === "left" ? "right" : "left"; edge = anchor === "left" ? px : imageW - px; }
  else {
    width = Math.min(oneLine, imageW * WRAP_SHARE);
    wraps = width < oneLine;
    anchor = "left";
    edge = Math.min(Math.max(0, px), imageW - width); // slid in from the left until its right side is inside too
  }
  const lines = wraps ? Math.max(1, Math.ceil(lineW / Math.max(1, width - chrome))) : 1;
  const height = lines * fontPx * 1.2 + 2 * (padY + border);
  return { anchor, edge, top: Math.min(Math.max(0, py), Math.max(0, imageH - height)), width, wraps };
}

interface Piece { html: string; at?: number }

/** One markup as HTML inside the picture's own coordinate space. `at` is when it appears, in ms from the start of its scene (none: it is there from the first frame). */
function markupPiece(m: Markup, id: string, atMs: number, abs: number, shot: RenderShot, shotSrc: string, endScale: number): Piece {
  const W = shot.width, H = shot.height;
  const sw = STROKE_PX / endScale;
  const stamp = `data-markup="${m.type}" data-at-ms="${abs}"`;
  switch (m.type) {
    case "circle": {
      const cx = c01(m.x) * W, cy = c01(m.y) * H, r = Math.max(0, m.r) * W;
      return { at: atMs, html: `<div class="mk ring" id="${id}" ${stamp} style="left:${n(cx - r)}px;top:${n(cy - r)}px;width:${n(2 * r)}px;height:${n(2 * r)}px;border-width:${n(sw)}px;opacity:0"></div>` };
    }
    case "arrow": {
      const x1 = c01(m.from.x) * W, y1 = c01(m.from.y) * H, x2 = c01(m.to.x) * W, y2 = c01(m.to.y) * H;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const a = Math.atan2(y2 - y1, x2 - x1);
      const hl = Math.min(4.5 * sw, len * 0.5);
      const side = (da: number) => `${n(x2 - hl * Math.cos(a + da))},${n(y2 - hl * Math.sin(a + da))}`;
      const bx = x2 - hl * 0.7 * Math.cos(a), by = y2 - hl * 0.7 * Math.sin(a);
      return {
        at: atMs,
        html: `<svg class="mk" id="${id}" ${stamp} width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}" style="left:0;top:0;opacity:0">`
          + `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(bx)}" y2="${n(by)}" stroke="${RED}" stroke-width="${n(sw)}" stroke-linecap="round"/>`
          + `<polygon points="${n(x2)},${n(y2)} ${side(Math.PI / 6)} ${side(-Math.PI / 6)}" fill="${RED}"/></svg>`,
      };
    }
    case "blur": {
      // Only the part inside the picture is blurred. The blurred copy of the picture sits inside its own cut-off box, so nothing spills over the edge.
      const x = c01(m.x), y = c01(m.y), w = Math.min(c01(m.w), 1 - x), h = Math.min(c01(m.h), 1 - y);
      const left = x * W, top = y * H;
      const blur = Math.min(120, Math.max(6, BLUR_PX / endScale));
      return {
        html: `<div class="mk blur" id="${id}" data-markup="blur" style="left:${n(left)}px;top:${n(top)}px;width:${n(w * W)}px;height:${n(h * H)}px">`
          + `<img src="${shotSrc}" alt="" style="left:${n(-left)}px;top:${n(-top)}px;width:${n(W)}px;height:${n(H)}px;filter:blur(${n(blur)}px)"/></div>`,
      };
    }
    case "callout": {
      const fs = CALLOUT_PX / endScale;
      const b = calloutBox(m, W, H, fs);
      const wrap = b.wraps ? `max-width:${n(b.width)}px;white-space:normal` : "white-space:nowrap";
      return { at: atMs, html: `<div class="mk callout" id="${id}" ${stamp} style="${b.anchor}:${n(b.edge)}px;top:${n(b.top)}px;${wrap};font-size:${n(fs)}px;padding:${n(fs * 0.3)}px ${n(fs * 0.55)}px;border-radius:${n(fs * 0.4)}px;border-width:${n(fs * 0.08)}px;opacity:0">${esc(m.text)}</div>` };
    }
  }
}

/**
 * The page for a whole video. `durationsMs` is how long each line's audio really is (measured by the caller, by line id): the lengths stored in the plan
 * are only estimates and are never used. Each line is a scene that starts when the previous one ended plus a 350 ms gap and holds until the next starts;
 * after the last line comes the same gap, then the 4 second end card. Throws, naming the line, for a line with no audio length or one over a shot that is not there.
 */
export function buildComposition(input: CompositionInput): Composition {
  const { plan, durationsMs, brand, ctaText } = input;
  const shots = new Map(plan.shots.map((s) => [s.id, s]));

  const sceneStartsMs: number[] = [];
  const lengths: number[] = [];
  let at = 0;
  for (const seg of plan.segments) {
    const d = durationsMs[seg.id];
    if (!(typeof d === "number" && Number.isFinite(d) && d > 0)) throw new Error(`Line ${seg.id} has no audio, so the video can't be put together yet.`);
    if (!shots.has(seg.shotId)) throw new Error(`Line ${seg.id} uses a screenshot (${seg.shotId}) that is not in this video.`);
    const len = Math.round(d);
    sceneStartsMs.push(at);
    lengths.push(len);
    at += len + GAP_MS;
  }
  const endStartMs = at;
  const totalMs = endStartMs + END_CARD_MS;

  const scenes: string[] = [];
  const audios: string[] = [];
  const tween: string[] = [];

  plan.segments.forEach((seg, i) => {
    const shot = shots.get(seg.shotId)!;
    if (!(shot.width > 0 && shot.height > 0)) throw new Error(`The screenshot ${shot.id} has no size.`);
    const start = sceneStartsMs[i];
    const sceneMs = lengths[i] + GAP_MS;
    const src = shotFile(shot);
    const whole: Rect = { x: 0, y: 0, w: shot.width, h: shot.height };
    const focus = focusRect(seg.focus, shot.width, shot.height);
    const end = cameraFor(focus ?? whole);
    // With a focus the camera starts from the whole shot and moves in; with none it settles from slightly closer, so the shot is never still on its first frame.
    const from = focus ? cameraFor(whole) : cameraFor({ x: shot.width * 0.02, y: shot.height * 0.02, w: shot.width * 0.96, h: shot.height * 0.96 });

    const pieces = seg.markups.map((m, j): Piece => {
      const appear = Math.min(MARKUP_AT_MS + j * MARKUP_STAGGER_MS, Math.max(MARKUP_AT_MS, sceneMs - 300));
      return markupPiece(m, `m${i}-${j}`, appear, start + appear, shot, src, end.scale);
    });
    // Blurs go first so everything else is drawn over them.
    const ordered = [...pieces.filter((p) => p.at === undefined), ...pieces.filter((p) => p.at !== undefined)];

    scenes.push(
      `<div class="scene clip" id="sc${i}" data-start="${sec(start)}" data-duration="${sec(sceneMs)}">`
      + `<div class="world" id="w${i}" style="width:${n(shot.width)}px;height:${n(shot.height)}px" data-layout-allow-overflow>`
      + `<img src="${src}" alt="" style="width:${n(shot.width)}px;height:${n(shot.height)}px"/>${ordered.map((p) => p.html).join("")}</div></div>`,
    );
    audios.push(`<audio id="au${i}" src="${audioFile(seg.id)}" data-start="${sec(start)}" data-duration="${sec(lengths[i])}" data-track-index="1"></audio>`);

    tween.push(`tl.fromTo("#w${i}", { ${camText(from)} }, { ${camText(end)}, duration: ${sec(CAMERA_MS)}, ease: "power2.inOut" }, ${sec(start)});`);
    pieces.forEach((p, j) => {
      if (p.at === undefined) return;
      const t = sec(start + p.at);
      const id = `#m${i}-${j}`;
      tween.push(seg.markups[j].type === "circle"
        ? `tl.fromTo("${id}", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: ${sec(FADE_MS)}, ease: "back.out(1.7)" }, ${t});`
        : `tl.to("${id}", { opacity: 1, duration: ${sec(FADE_MS)}, ease: "power1.out" }, ${t});`);
    });
  });

  const endCard =
    `<div class="scene card clip" id="end" data-start="${sec(endStartMs)}" data-duration="${sec(END_CARD_MS)}">`
    + `<div class="card-in" id="end-in"><div class="card-name">${esc(brand.name)}</div><div class="card-biz">${esc(brand.business)}</div><div class="card-cta">${esc(ctaText)}</div></div></div>`;
  tween.push(`tl.fromTo("#end-in", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, ${sec(endStartMs + 100)});`);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${FRAME_W}, height=${FRAME_H}" />
<script src="${GSAP_URL}" integrity="${GSAP_SRI}" crossorigin="anonymous"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden;background:${BACKGROUND}}
#root{position:relative;width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden;font-family:${FONT_STACK}}
.scene{position:absolute;left:0;top:0;width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden;background:${BACKGROUND}}
.world{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden}
.world>img{position:absolute;left:0;top:0;display:block;max-width:none}
.mk{position:absolute}
.ring{border-style:solid;border-color:${RED};border-radius:50%}
.blur{overflow:hidden}
.blur img{position:absolute;display:block;max-width:none}
.callout{background:#111827;color:#fff;border-style:solid;border-color:${RED};font-weight:600;line-height:1.2}
.card{display:flex;align-items:center;justify-content:center;text-align:center;color:#fff}
.card-in{display:flex;flex-direction:column;align-items:center;gap:18px}
.card-name{font-size:64px;font-weight:700;letter-spacing:-0.02em}
.card-biz{font-size:34px;font-weight:500;opacity:0.8}
.card-cta{margin-top:26px;font-size:34px;font-weight:600;padding:16px 34px;border-radius:14px;background:${RED}}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${sec(totalMs)}" data-width="${FRAME_W}" data-height="${FRAME_H}">
${scenes.join("\n")}
${endCard}
${audios.join("\n")}
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
${tween.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
  return { files: { "index.html": html }, totalMs, sceneStartsMs };
}

// --- the report video ----------------------------------------------------------------------------------------------------------------------------------------------

/** The short video of a Care or Local SEO report: a square, silent page of captions. A scene's words are all the page shows. */
export interface ReportScene { title: string; big: string; small: string }
export const REPORT_FRAME = 1080;
export const REPORT_SCENE_MS = 6000;
export const REPORT_FADE_MS = 1000;
export const MAX_REPORT_SCENES = 6;
/** The widest the big number may be (the page is 1080 px wide), and the average width of a bold character as a fraction of its size, deliberately on the wide side. */
const BIG_MAX_WIDTH = 920;
const BIG_CHAR_EM = 0.62;
const BIG_MAX_PX = 220;
const BIG_MIN_PX = 72;

/** The big number's size: the largest that fits on one line, up to 220 px. */
const bigPx = (text: string): number => Math.max(BIG_MIN_PX, Math.min(BIG_MAX_PX, Math.floor(BIG_MAX_WIDTH / (Math.max(1, Array.from(text).length) * BIG_CHAR_EM))));

/**
 * The page for a report's video: one scene every 6 seconds, each a title, a big number and a line of small text, centred on the brand background with the sender's name small at the foot. Silent (no audio element).
 * Every scene but the first fades in over a second (the first is there from the first frame, so the poster, a frame at 0, shows the title card) and every scene but the last fades out over its final second.
 * Pure and deterministic. Throws for no scenes or more than 6.
 */
export function buildReportComposition(scenes: ReportScene[], brand: { name: string }): Composition {
  if (scenes.length === 0) throw new Error("A report video needs at least one scene.");
  if (scenes.length > MAX_REPORT_SCENES) throw new Error(`A report video has at most ${MAX_REPORT_SCENES} scenes, and this one has ${scenes.length}.`);
  const totalMs = scenes.length * REPORT_SCENE_MS;
  const sceneStartsMs = scenes.map((_, i) => i * REPORT_SCENE_MS);

  const blocks = scenes.map((sc, i) =>
    `<div class="scene clip" id="sc${i}" data-start="${sec(sceneStartsMs[i])}" data-duration="${sec(REPORT_SCENE_MS)}">`
    + `<div class="rv-in" id="in${i}"><div class="rv-title">${esc(sc.title)}</div><div class="rv-bar"></div>`
    + `<div class="rv-big" style="font-size:${bigPx(sc.big)}px">${esc(sc.big)}</div><div class="rv-small">${esc(sc.small)}</div></div>`
    + `<div class="rv-brand">${esc(brand.name)}</div></div>`,
  );
  const tween: string[] = [];
  scenes.forEach((_, i) => {
    const start = sceneStartsMs[i];
    if (i > 0) tween.push(`tl.fromTo("#in${i}", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: ${sec(REPORT_FADE_MS)}, ease: "power2.out" }, ${sec(start)});`);
    if (i < scenes.length - 1) tween.push(`tl.to("#in${i}", { opacity: 0, duration: ${sec(REPORT_FADE_MS)}, ease: "power1.in" }, ${sec(start + REPORT_SCENE_MS - REPORT_FADE_MS)});`);
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${REPORT_FRAME}, height=${REPORT_FRAME}" />
<script src="${GSAP_URL}" integrity="${GSAP_SRI}" crossorigin="anonymous"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${REPORT_FRAME}px;height:${REPORT_FRAME}px;overflow:hidden;background:${BACKGROUND}}
#root{position:relative;width:${REPORT_FRAME}px;height:${REPORT_FRAME}px;overflow:hidden;font-family:${FONT_STACK}}
.scene{position:absolute;left:0;top:0;width:${REPORT_FRAME}px;height:${REPORT_FRAME}px;overflow:hidden;background:${BACKGROUND};display:flex;align-items:center;justify-content:center;text-align:center;color:#fff}
.rv-in{display:flex;flex-direction:column;align-items:center;gap:28px;width:920px}
.rv-title{font-size:44px;font-weight:600;line-height:1.2;opacity:0.85}
.rv-bar{width:96px;height:8px;border-radius:4px;background:${RED}}
.rv-big{font-weight:800;letter-spacing:-0.03em;line-height:1.05;white-space:nowrap}
.rv-small{font-size:42px;font-weight:500;line-height:1.3;opacity:0.8}
.rv-brand{position:absolute;left:0;right:0;bottom:56px;font-size:30px;font-weight:600;opacity:0.55}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${sec(totalMs)}" data-width="${REPORT_FRAME}" data-height="${REPORT_FRAME}">
${blocks.join("\n")}
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
${tween.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
  return { files: { "index.html": html }, totalMs, sceneStartsMs };
}
