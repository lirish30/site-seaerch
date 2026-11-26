// Pure slide templates for the Studio's social images (Plan 15): copy in, escaped self-contained HTML out. No I/O here.
// Every piece of text goes through `esc`, and an image is either a `data:` URI or left out, so a slide never makes a request of its own.
import type { StudioKind } from "../db/studio";
import { SITELINE, SITELINE_BASE_CSS, flowLinesSvg, wordmarkHtml } from "../brand/siteline";
import { STUDIO_BRAND as B } from "./brand";

export const STUDIO_SIZE = { width: 1080, height: 1350 } as const;

/** What Claude writes for a post (its result schema matches this exactly). */
export interface StudioCopy { headline: string; caption: string; slides: { title: string; body: string }[]; tags: string[] }

/** One image. `before` and `after` are `data:` URIs. */
export type StudioSlide = {
  kind: "cover" | "tip" | "before_after" | "case" | "close"; title: string; body: string; before?: string; after?: string;
  /** Where the slide sits in its post (1 of `pages`), shown small at the foot; and, for a tip, which tip it is. All optional: a slide drawn alone shows the site's address instead. */
  page?: number; pages?: number; n?: number;
};

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

/** The slides for a post: audit tips are a cover, up to four tips and a close (six at most), a before and after is a cover and one image slide, a case study is one card. Each knows its place in the post. */
export function slidesFor(kind: StudioKind, copy: StudioCopy, assets: { before?: string; after?: string }): StudioSlide[] {
  let tip = 0;
  return build(kind, copy, assets).map((s, i, all): StudioSlide => ({ ...s, page: i + 1, pages: all.length, ...(s.kind === "tip" ? { n: ++tip } : {}) }));
}

function build(kind: StudioKind, copy: StudioCopy, assets: { before?: string; after?: string }): StudioSlide[] {
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

/** A headline with its last word picked out (green on paper, mint on night), the way the homepage does it. One word, or none, is left plain. Everything is escaped. */
function headline(text: string): string {
  const t = clip(text, TITLE_MAX);
  const at = t.search(/\s\S+$/);
  return at < 0 ? esc(t) : `${esc(t.slice(0, at + 1))}<span class="sl-hl">${esc(t.slice(at + 1))}</span>`;
}

const paragraphs = (s: string, max: number): string => s.split(/\n{2,}/).map((p) => clip(p, max)).filter(Boolean).slice(0, CASE_SECTIONS).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
/** A case card's sections ("title: body"): the title as a small mono label over a hairline, then the body. */
const sections = (s: string): string => s.split(/\n{2,}/).map((p) => clip(p, SECTION_MAX)).filter(Boolean).slice(0, CASE_SECTIONS).map((p) => {
  const at = p.indexOf(": ");
  const [k, v] = at > 0 && at <= TITLE_MAX ? [p.slice(0, at), p.slice(at + 2)] : ["", p];
  return `<div class="sec">${k ? `<div class="sl-label k">${esc(k)}</div>` : ""}<p>${esc(v).replace(/\n/g, "<br>")}</p></div>`;
}).join("");

const CSS = `
${SITELINE_BASE_CSS}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{width:${STUDIO_SIZE.width}px;height:${STUDIO_SIZE.height}px;overflow:hidden;background:${B.background};color:${B.ink};font-family:${B.bodyFont};-webkit-font-smoothing:antialiased}
/* Overflow-safe: the slide starts at the top and the inner wrapper centres itself with auto margins, so short copy sits in the middle and long copy loses its tail, never its headline. */
.slide{position:relative;width:${STUDIO_SIZE.width}px;height:${STUDIO_SIZE.height}px;padding:96px 88px 72px;display:flex;flex-direction:column;justify-content:flex-start;overflow:hidden;background:${B.background}}
.slide.close{background:${B.night};color:#fff}
.guides{position:absolute;inset:0;pointer-events:none;background:linear-gradient(to right,transparent calc(100% - 2px),${B.line} 0) 0 0/25% 100% repeat-x;opacity:.3}
.fit{position:relative;margin:auto 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:40px}
.before_after .fit{flex:1;margin:0;gap:28px}
h1,p{min-width:0;overflow-wrap:anywhere;word-break:break-word;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}
h1{margin:0;font-family:${B.headingFont};font-weight:300;letter-spacing:-.04em;line-height:1.04;font-size:92px;-webkit-line-clamp:4}
.cover h1{font-size:112px}.close h1{font-size:96px;color:#fff}.case h1{font-size:68px;-webkit-line-clamp:3}.before_after h1{font-size:72px;-webkit-line-clamp:2}
p{margin:0 0 24px;font-size:42px;line-height:1.4;font-weight:400;letter-spacing:-.01em;color:${B.muted};-webkit-line-clamp:5}
.close p{color:#a9b2ad}
.case p{font-size:34px;line-height:1.4;-webkit-line-clamp:4;margin:0}.before_after p{font-size:36px;-webkit-line-clamp:3;margin:0}
.tip p{color:${B.ink}}
.slide .sl-eyebrow{font-size:26px;gap:14px;letter-spacing:.1em}.slide .sl-eyebrow::before{width:12px;height:12px}
.slide .sl-rule{width:120px;height:2px}
.close .sl-rule{background:#fff}
.cap{font:400 24px/1.3 ${B.monoFont};letter-spacing:.08em;text-transform:uppercase;color:${B.muted}}
.close .cap{color:#a9b2ad}
.body{min-width:0}
.body:empty{display:none}
.case .body{display:flex;flex-direction:column;gap:28px}
.sec{border-top:1px solid ${B.line};padding-top:22px;display:flex;flex-direction:column;gap:12px;min-width:0}
.sec .k{font-size:22px;color:${B.accent}}
.pair{display:flex;gap:32px;flex:1;min-height:0}
.pair figure{flex:1;min-width:0;min-height:0;margin:0;display:flex;flex-direction:column}
.pair img,.pair .noimg{display:block;width:100%;flex:1;min-height:0;height:0;object-fit:cover;border-radius:0;border:1px solid ${B.line};background:${B.mist}}
.pair figcaption{margin-top:16px;font:400 24px/1.2 ${B.monoFont};letter-spacing:.08em;text-transform:uppercase;color:${B.muted}}
.pair .after figcaption{color:${B.accent};display:flex;align-items:center;gap:12px}
.pair .after figcaption::before{content:"";width:12px;height:12px;border-radius:50%;background:${B.accent};flex:none}
.flow{flex:none;position:relative;height:300px;margin:0 -88px;color:#fff}
.flow svg{display:block;width:100%;height:100%}
.foot{position:relative;flex:none;margin-top:48px;display:flex;justify-content:space-between;align-items:center;font:400 22px/1 ${B.monoFont};letter-spacing:.08em;text-transform:uppercase;color:${B.muted}}
.close .foot{color:#a9b2ad}
.slide .sl-mark{font-size:36px}.slide .sl-mark i{width:14px;height:14px;margin-left:6px}
.close .sl-mark{color:#fff}
.foot .sl-mark{text-transform:none;letter-spacing:-.02em}
`;

const LABEL: Record<StudioSlide["kind"], string> = { cover: "", tip: "Tip", before_after: "Before and after", case: "Case study", close: "" };
const two = (n: number): string => String(n).padStart(2, "0");

function pair(s: StudioSlide): string {
  const fig = (cls: string, src: string | null, label: string) => `<figure class="${cls}">${src ? `<img src="${esc(src)}" alt="${esc(label)}">` : `<div class="noimg"></div>`}<figcaption>${esc(label)}</figcaption></figure>`;
  return `<div class="pair">${fig("before", imgSrc(s.before), "Before")}${fig("after", imgSrc(s.after), "After")}</div>`;
}

/** One slide as a complete HTML page the size of the image: inline CSS (Geist embedded), `data:` images only, every piece of text escaped. */
export function renderSlideHtml(s: StudioSlide): string {
  const label = s.kind === "tip" && s.n ? `Tip ${two(s.n)}` : LABEL[s.kind];
  const dark = s.kind === "close";
  const count = s.page && s.pages ? `${two(s.page)} / ${two(s.pages)}` : SITELINE.site;
  // The cover and the closing slide carry the short rule and the address under the headline, like the cover of a Third and Grove document.
  const sign = s.kind === "cover" || dark ? `<hr class="sl-rule"><div class="cap">${esc(SITELINE.site)}</div>` : "";
  const text = s.kind === "case" ? sections(s.body) : paragraphs(s.body, BODY_MAX);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${STUDIO_SIZE.width}"><title>${esc(clip(s.title, TITLE_MAX) || "Studio")}</title><style>${CSS}</style></head>`
    + `<body><section class="slide ${s.kind}${dark ? " sl-dark" : ""}">${s.kind === "cover" ? `<div class="guides"></div>` : ""}<div class="fit">${label ? `<div class="sl-eyebrow">${esc(label)}</div>` : ""}<h1>${headline(s.title)}</h1>${
      s.kind === "before_after" ? pair(s) : ""}<div class="body">${text}</div>${sign}</div>${
      dark ? `<div class="flow">${flowLinesSvg({ width: STUDIO_SIZE.width, height: 300, dir: "right", lines: 11, opacity: 0.3 })}</div>` : ""
    }<footer class="foot">${wordmarkHtml()}<span>${esc(count)}</span></footer></section></body></html>`;
}
