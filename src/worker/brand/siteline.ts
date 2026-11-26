// The Siteline look for everything we hand a client or prospect as a document: decks, audit reports, report images.
// Source: Figma "Siteline · Homepage / 1440 · v6" (69:1988) and its system frame (67:1958), tokens in the "Siteline v6" variable collection.
// Layout (cover, running header, footer, whitespace) follows the Third and Grove SOW example; type and colour follow the homepage.
// Fonts are embedded as base64 (see fontData.ts) so a rendered document makes no request of its own.
import { GEIST_MONO_WOFF2_BASE64, GEIST_SANS_WOFF2_BASE64 } from "./fontData";

export const SITELINE = {
  paper: "#f4f5ef",
  card: "#ffffff",
  ink: "#07090a",
  night: "#0c0f0e",
  mist: "#e9ece3",
  line: "#d3d8cc",
  muted: "#59625d",
  mint: "#00e5a0",
  green: "#0a7a55",
  sans: `"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
  mono: `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  /** The wordmark until a logo file exists. */
  name: "Siteline",
  site: "sitelineweb.com",
} as const;

/** @font-face for Geist and Geist Mono, embedded. Put it once in a document's <style>. */
export const SITELINE_FONT_FACE_CSS =
  `@font-face{font-family:"Geist";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${GEIST_SANS_WOFF2_BASE64}) format("woff2")}` +
  `@font-face{font-family:"Geist Mono";font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${GEIST_MONO_WOFF2_BASE64}) format("woff2")}`;

/** CSS custom properties, so a template can write `var(--sl-ink)`. */
export const SITELINE_VARS_CSS =
  `:root{--sl-paper:${SITELINE.paper};--sl-card:${SITELINE.card};--sl-ink:${SITELINE.ink};--sl-night:${SITELINE.night};--sl-mist:${SITELINE.mist};--sl-line:${SITELINE.line};` +
  `--sl-muted:${SITELINE.muted};--sl-mint:${SITELINE.mint};--sl-green:${SITELINE.green};--sl-sans:${SITELINE.sans};--sl-mono:${SITELINE.mono}}`;

/**
 * Shared building blocks, all prefixed `sl-` so they cannot collide with a template's own classes:
 * eyebrow (mono caps with a green dot), highlight word, hairline rule, arrow button, square card, check list, guide lines, running header and footer.
 */
export const SITELINE_COMPONENTS_CSS = `
.sl-eyebrow{display:inline-flex;align-items:center;gap:8px;font:400 12px/1.2 var(--sl-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--sl-ink)}
.sl-eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--sl-green);flex:none}
.sl-dark .sl-eyebrow{color:#fff}.sl-dark .sl-eyebrow::before{background:var(--sl-mint)}
.sl-hl{color:var(--sl-green)}.sl-dark .sl-hl{color:var(--sl-mint)}
.sl-rule{width:96px;height:1px;background:var(--sl-ink);opacity:.35;border:0;margin:0}
.sl-card{background:var(--sl-card);border:1px solid var(--sl-line);border-radius:0}
.sl-card.sl-strong{border:1.5px solid var(--sl-ink)}
.sl-label{font:400 11px/1.3 var(--sl-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--sl-muted)}
.sl-tag{display:inline-block;padding:3px 8px;background:var(--sl-mint);color:var(--sl-ink);font:400 10px/1.3 var(--sl-mono);letter-spacing:.08em;text-transform:uppercase}
.sl-checks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.sl-checks li{position:relative;padding-left:24px}
.sl-checks li::before{content:"";position:absolute;left:2px;top:.42em;width:10px;height:5px;border-left:1.6px solid var(--sl-green);border-bottom:1.6px solid var(--sl-green);transform:rotate(-45deg)}
.sl-btn{display:inline-flex;align-items:stretch;height:48px;border:1px solid var(--sl-ink);background:var(--sl-card);color:var(--sl-ink);font:500 16px/1 var(--sl-sans);text-decoration:none}
.sl-btn .ic{display:grid;place-items:center;width:48px;background:var(--sl-ink);color:var(--sl-mint)}
.sl-btn .lb{display:flex;align-items:center;padding:0 20px}
.sl-btn.sl-primary{background:var(--sl-mint)}
.sl-dark .sl-btn{border-color:var(--sl-mint)}.sl-dark .sl-btn.sl-primary .ic{background:#fff;color:var(--sl-ink)}
.sl-guides{position:absolute;inset:0;pointer-events:none;background:linear-gradient(to right,transparent calc(100% - 1px),var(--sl-line) 0) 0 0/25% 100% repeat-x;opacity:.35}
.sl-run{display:flex;justify-content:space-between;align-items:flex-start}
.sl-mark{font:600 20px/1 var(--sl-sans);letter-spacing:-.02em;color:var(--sl-ink)}
.sl-mark i{display:inline-block;width:8px;height:8px;margin-left:4px;border-radius:50%;background:var(--sl-mint)}
.sl-contact{font:400 10px/1.5 var(--sl-mono);letter-spacing:.04em;color:var(--sl-muted);text-align:right}
.sl-doc{font:600 14px/1.3 var(--sl-sans);color:var(--sl-ink)}.sl-doc span{font-weight:400;color:var(--sl-muted)}
.sl-foot{font:400 10px/1.4 var(--sl-mono);letter-spacing:.04em;color:var(--sl-muted)}
.sl-foot::before{content:"";display:block;width:96px;height:1px;background:var(--sl-ink);opacity:.35;margin-bottom:8px}
`;

/** The arrow in a button's icon cell. */
export const ARROW_SVG = `<svg width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M0 7h19M13 1l6 6-6 6"/></svg>`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A button as markup (for print and screen documents it is a plain element, not a link). */
export function buttonHtml(label: string, o: { primary?: boolean } = {}): string {
  return `<span class="sl-btn${o.primary ? " sl-primary" : ""}"><span class="ic">${ARROW_SVG}</span><span class="lb">${esc(label)}</span></span>`;
}

/** The wordmark: the name with a mint dot, until a logo file exists. */
export const wordmarkHtml = (): string => `<span class="sl-mark">${SITELINE.name}<i></i></span>`;

/**
 * Flow lines: a bundle of thin lines that narrows to one mint line, the graphic behind the homepage's closing section.
 * `dir` is the side the bundle opens from. Colours come from `currentColor` (the lines) and the mint line, so it works on paper and on night.
 */
export function flowLinesSvg(o: { width: number; height: number; dir: "left" | "right"; lines?: number; opacity?: number }): string {
  const n = Math.max(3, o.lines ?? 13);
  const { width: w, height: h } = o;
  const mid = h / 2;
  const x = (v: number): number => (o.dir === "left" ? v : w - v);
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = (h * (i + 0.5)) / n;
    if (Math.abs(y - mid) < h / n / 2) continue;
    paths.push(`<path d="M${x(0)} ${y.toFixed(1)}C${x(w * 0.55).toFixed(1)} ${y.toFixed(1)} ${x(w * 0.6).toFixed(1)} ${mid} ${x(w)} ${mid}"/>`);
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1" opacity="${o.opacity ?? 0.35}">${paths.join("")}</g>` +
    `<path d="M${x(0)} ${mid}H${x(w)}" stroke="${SITELINE.mint}" stroke-width="1.5"/></svg>`;
}

/** The Grove-style running header of an inner page: wordmark left, contact right, then the document name and the client. */
export function runningHeaderHtml(o: { document: string; client?: string | null; contact?: string }): string {
  return `<header class="sl-head"><div class="sl-run">${wordmarkHtml()}<div class="sl-contact">${esc(o.contact ?? SITELINE.site)}</div></div>` +
    `<div class="sl-doc">${esc(o.document)}${o.client ? ` <span>/ ${esc(o.client)}</span>` : ""}</div></header>`;
}

/** The Grove-style footer: a short rule, then `PAGE n / (c) year Siteline, Confidential`. */
export function footerHtml(o: { page: number | string; year: number }): string {
  return `<footer class="sl-foot">PAGE ${esc(String(o.page))} / &copy;${o.year} ${SITELINE.name}. Proprietary and confidential.</footer>`;
}

/** Everything a self-contained document needs in its <style>: variables, fonts, shared components. */
export const SITELINE_BASE_CSS = `${SITELINE_FONT_FACE_CSS}${SITELINE_VARS_CSS}${SITELINE_COMPONENTS_CSS}`;
