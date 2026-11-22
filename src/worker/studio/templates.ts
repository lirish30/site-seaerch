// Pure slide templates for the Studio's social images (Plan 15): copy in, escaped self-contained HTML out. No I/O here.
// Every piece of text goes through `esc`, and an image is either a `data:` URI or left out, so a slide never makes a request of its own.
import type { StudioKind } from "../db/studio";
import { STUDIO_BRAND as B } from "./brand";

export const STUDIO_SIZE = { width: 1080, height: 1350 } as const;

/** What Claude writes for a post (its result schema matches this exactly). */
export interface StudioCopy { headline: string; caption: string; slides: { title: string; body: string }[]; tags: string[] }

/** One image. `before` and `after` are `data:` URIs. */
export type StudioSlide = { kind: "cover" | "tip" | "before_after" | "case" | "close"; title: string; body: string; before?: string; after?: string };

export const MAX_TIP_SLIDES = 4;
const CASE_SECTIONS = 3;
/** The longest a slide's title and body run, matching the limits Claude's result is held to; longer text is cut with an ellipsis, never rejected. */
export const TITLE_MAX = 60;
export const BODY_MAX = 140;
/** A case card's section is "title: body". */
const SECTION_MAX = TITLE_MAX + 2 + BODY_MAX;

/** `s` cut to at most `max` characters (whole characters, not half a pair), ending in an ellipsis when it was cut. */
export function clip(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}\u2026`;
}
const CLOSE_TITLE = "Save this for later";

/** The slides for a post: audit tips are a cover, up to four tips and a close (six at most), a before and after is a cover and one image slide, a case study is one card. */
export function slidesFor(kind: StudioKind, copy: StudioCopy, assets: { before?: string; after?: string }): StudioSlide[] {
  const headline = clip(copy.headline, TITLE_MAX);
  const items = copy.slides.map((t) => ({ title: clip(t.title, TITLE_MAX), body: clip(t.body, BODY_MAX) }));
  switch (kind) {
    case "audit_tip": {
      const tips = items.slice(0, MAX_TIP_SLIDES);
      // A fifth item written by Claude is the closing line; without one the close is a plain reminder.
      const closing = items[MAX_TIP_SLIDES];
      return [
        { kind: "cover", title: headline, body: "" },
        ...tips.map((t): StudioSlide => ({ kind: "tip", title: t.title, body: t.body })),
        { kind: "close", title: closing?.title || CLOSE_TITLE, body: closing?.body ?? "" },
      ];
    }
    case "before_after": {
      const first = items[0];
      return [
        { kind: "cover", title: headline, body: "" },
        { kind: "before_after", title: first?.title ?? "", body: first?.body ?? "", before: assets.before, after: assets.after },
      ];
    }
    case "case_study":
      return [{ kind: "case", title: headline, body: items.slice(0, CASE_SECTIONS).map((s) => `${s.title}: ${s.body}`).join("\n\n") }];
  }
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** An image source is a `data:` URI or nothing. */
const imgSrc = (u: string | undefined): string | null => (u !== undefined && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : null);
const paragraphs = (s: string, max: number): string => s.split(/\n{2,}/).map((p) => clip(p, max)).filter(Boolean).slice(0, CASE_SECTIONS).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

const CSS = `
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{width:${STUDIO_SIZE.width}px;height:${STUDIO_SIZE.height}px;overflow:hidden;background:${B.background};color:${B.ink};font-family:${B.bodyFont};-webkit-font-smoothing:antialiased}
/* Overflow-safe: the slide starts at the top and the inner wrapper centres itself with auto margins, so short copy sits in the middle and long copy loses its tail, never its headline. */
.slide{position:relative;width:${STUDIO_SIZE.width}px;height:${STUDIO_SIZE.height}px;padding:96px 88px;display:flex;flex-direction:column;justify-content:flex-start;overflow:hidden;border-top:16px solid ${B.accent}}
.fit{margin:auto 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:36px}
.before_after .fit{flex:1;margin:0;gap:28px}
h1,p{min-width:0;overflow-wrap:anywhere;word-break:break-word;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}
h1{margin:0;font-family:${B.headingFont};font-weight:800;letter-spacing:-.02em;line-height:1.08;font-size:84px;-webkit-line-clamp:4}
.cover h1{font-size:104px}.close h1{font-size:80px}.case h1{font-size:64px;-webkit-line-clamp:3}.before_after h1{font-size:68px;-webkit-line-clamp:2}
p{margin:0 0 24px;font-size:44px;line-height:1.35;color:${B.muted};-webkit-line-clamp:5}
.case p{font-size:36px;-webkit-line-clamp:4}.before_after p{font-size:38px;-webkit-line-clamp:3;margin:0}
.tip p,.before_after p{color:${B.ink}}
.eyebrow{font-size:28px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${B.accent}}
.body{min-width:0}
.pair{display:flex;gap:32px;flex:1;min-height:0}
.pair figure{flex:1;min-width:0;min-height:0;margin:0;display:flex;flex-direction:column}
.pair img,.pair .noimg{display:block;width:100%;flex:1;min-height:0;height:0;object-fit:cover;border-radius:20px;background:#e3e0d8}
.pair figcaption{margin-top:14px;font-size:28px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${B.muted}}
.pair .after figcaption{color:${B.accent}}
`;

const LABEL: Record<StudioSlide["kind"], string> = { cover: "", tip: "Tip", before_after: "Before and after", case: "Case study", close: "" };

function pair(s: StudioSlide): string {
  const fig = (cls: string, src: string | null, label: string) => `<figure class="${cls}">${src ? `<img src="${esc(src)}" alt="${esc(label)}">` : `<div class="noimg"></div>`}<figcaption>${esc(label)}</figcaption></figure>`;
  return `<div class="pair">${fig("before", imgSrc(s.before), "Before")}${fig("after", imgSrc(s.after), "After")}</div>`;
}

/** One slide as a complete HTML page the size of the image: inline CSS, `data:` images only, every piece of text escaped. */
export function renderSlideHtml(s: StudioSlide): string {
  const label = LABEL[s.kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${STUDIO_SIZE.width}"><title>${esc(clip(s.title, TITLE_MAX) || "Studio")}</title><style>${CSS}</style></head>`
    + `<body><section class="slide ${s.kind}"><div class="fit">${label ? `<div class="eyebrow">${esc(label)}</div>` : ""}<h1>${esc(clip(s.title, TITLE_MAX))}</h1>${
      s.kind === "before_after" ? pair(s) : ""}<div class="body">${paragraphs(s.body, s.kind === "case" ? SECTION_MAX : BODY_MAX)}</div></div></section></body></html>`;
}
