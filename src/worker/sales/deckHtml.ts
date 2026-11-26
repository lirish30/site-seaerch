import { SITELINE, SITELINE_BASE_CSS, flowLinesSvg, footerHtml, runningHeaderHtml, wordmarkHtml } from "../brand/siteline";
import type { DeckBlock, DeckSlide } from "./deck";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** An image source is a `data:` URI or nothing: a deck makes no request of its own. */
const imgSrc = (u: string | null): string | null => (u !== null && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : null);
const paragraphs = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");

/** A headline with its last word in the accent colour, the way the Siteline homepage sets every headline. The text is escaped before the span goes in. */
function headline(s: string): string {
  const t = esc(s);
  const i = t.lastIndexOf(" ");
  return i < 0 ? `<span class="sl-hl">${t}</span>` : `${t.slice(0, i + 1)}<span class="sl-hl">${t.slice(i + 1)}</span>`;
}

/** "Ace Plumbing - Recommendation" is a client and a document name; a title with no dash is only a document name. */
function titleParts(title: string): { document: string; client: string | null } {
  const i = title.lastIndexOf(" - ");
  return i > 0 ? { client: title.slice(0, i), document: title.slice(i + 3) } : { document: title, client: null };
}

function listHtml(b: Extract<DeckBlock, { type: "list" }>): string {
  const tag = b.numbered ? "ol" : "ul";
  const titled = b.items.some((i) => i.title);
  const rows = b.numbered || titled;
  const n = b.items.length;
  const cls = ["items", rows ? "rows" : "sl-checks", b.numbered ? "num" : "", titled ? "titled" : "", n > 5 ? "dense" : n < 5 && rows ? "roomy" : "", n > 6 ? "two" : ""].filter(Boolean).join(" ");
  const li = (i: { title?: string; text: string }): string => {
    const verdict = titled && /^(pass|flag)$/i.test(i.text) ? ` verdict ${i.text.toLowerCase()}` : "";
    return `<li>${i.title ? `<strong>${esc(i.title)}</strong>` : ""}<span class="tx${verdict}">${esc(i.text)}</span></li>`;
  };
  return `<div class="list">${b.heading ? `<h3 class="sl-label lh">${esc(b.heading)}</h3>` : ""}<${tag} class="${cls}">${b.items.map(li).join("")}</${tag}></div>`;
}

function block(b: DeckBlock): string {
  switch (b.type) {
    case "text": return b.style === "eyebrow" ? `<p class="t eyebrow sl-eyebrow">${esc(b.text)}</p>` : `<p class="t ${b.style ?? ""}">${esc(b.text)}</p>`;
    case "list": return listHtml(b);
    case "stat": return `<div class="stat">${b.op ? `<span class="op">${b.op === "times" ? "&times;" : "="}</span>` : ""}<strong>${esc(b.value)}</strong><span>${esc(b.label)}</span></div>`;
    case "price": return `<p class="price${b.text.length > 14 ? " long" : ""}">${esc(b.text)}</p>`;
    case "image": {
      const src = imgSrc(b.dataUri);
      return `<figure class="card sl-card">${src ? `<img src="${esc(src)}" alt="${esc(b.alt)}">` : `<div class="noimg"></div>`}<div class="cap">${b.label ? `<small class="sl-label">${esc(b.label)}</small>` : ""}${
        b.title ? `<h3>${esc(b.title)}</h3>` : ""}${b.text ? `<p>${esc(b.text)}</p>` : ""}</div></figure>`;
    }
    case "option": return `<div class="card sl-card opt${b.recommended ? " rec sl-strong" : ""}">${b.recommended ? `<small class="badge sl-tag">Recommended</small>` : ""}<h3>${esc(b.label)}</h3>${
      b.tagline ? `<p class="tag">${esc(b.tagline)}</p>` : ""}<ul class="items">${b.items.map((i) => `<li><strong>${esc(i.name)}</strong> <span>${esc(i.price)}</span></li>`).join("")}</ul>${
      b.includes?.length ? `<ul class="items inc sl-checks">${b.includes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}<p class="tot">${
      [b.upfront && `${esc(b.upfront)} up front`, b.monthly && esc(b.monthly)].filter(Boolean).join(" + ")}</p></div>`;
  }
}

const isHeadedList = (b: DeckBlock | undefined): boolean => b?.type === "list" && !!b.heading;

/** Groups neighbouring blocks of the same kind (cards, stats) so they sit side by side; everything else stacks. */
function body(blocks: DeckBlock[]): string {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; ) {
    const t = blocks[i].type;
    if (t === "image" || t === "option" || t === "stat") {
      let j = i;
      while (j < blocks.length && blocks[j].type === t) j++;
      out.push(`<div class="row ${t} n${j - i}">${blocks.slice(i, j).map(block).join("")}</div>`);
      i = j;
    } else if (isHeadedList(blocks[i]) && isHeadedList(blocks[i + 1])) {
      // Two or more lists that each have a heading ("Your goals", "Where things are now") sit side by side.
      let j = i;
      while (j < blocks.length && isHeadedList(blocks[j])) j++;
      out.push(`<div class="row lists n${j - i}">${blocks.slice(i, j).map(block).join("")}</div>`);
      i = j;
    } else { out.push(block(blocks[i])); i++; }
  }
  return out.join("");
}

/**
 * On the cover the lead line reads "what it is  ·  Prepared for X  ·  Month Year". Set it the way the Grove cover sets it: the description, the prepared-for line,
 * then a short rule and the date small and grey. A lead without that shape stays one line. No words are added or dropped.
 */
function coverLead(text: string): string {
  const parts = text.split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return `<p class="t lead">${esc(text)}</p>`;
  const date = parts.length > 2 && /\d{4}$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
  const middle = parts.slice(1, date ? -1 : undefined);
  return `<p class="t lead">${esc(parts[0])}</p><p class="t prep">${esc(middle.join("  ·  "))}</p>${date ? `<hr class="sl-rule"><p class="meta">${esc(date)}</p>` : ""}`;
}

function slideHtml(s: DeckSlide, n: number, ctx: { document: string; client: string | null; year: number }): string {
  const eyebrows = s.blocks.filter((b) => b.type === "text" && b.style === "eyebrow");
  const rest = s.blocks.filter((b) => !(b.type === "text" && b.style === "eyebrow"));
  const attrs = `id="s${n}" data-n="${n}"`;
  const foot = footerHtml({ page: n, year: ctx.year });
  if (s.key === "title") {
    const inner = rest.map((b) => (b.type === "text" && b.style === "lead" ? coverLead(b.text) : body([b]))).join("");
    return `<section class="slide k-title" ${attrs}><div class="guides"></div><div class="cover-mark">${wordmarkHtml()}</div><div class="in">${eyebrows.map(block).join("")}<h1${s.title.length > 44 ? ' class="l3"' : s.title.length > 26 ? ' class="l2"' : ""}>${headline(s.title)}</h1><div class="body">${inner}</div></div>${foot}</section>`;
  }
  if (s.key === "thanks") {
    return `<section class="slide k-thanks sl-dark" ${attrs}><div class="guides"></div><div class="flow l">${flowLinesSvg({ width: 360, height: 340, dir: "left" })}</div><div class="flow r">${
      flowLinesSvg({ width: 360, height: 340, dir: "right" })}</div><div class="cover-mark">${wordmarkHtml()}</div><div class="in">${eyebrows.map(block).join("")}<h1>${headline(s.title)}</h1><div class="body">${body(rest)}</div></div>${foot}</section>`;
  }
  return `<section class="slide k-${esc(s.key)}" ${attrs}><div class="guides"></div>${runningHeaderHtml({ document: ctx.document, client: ctx.client })}<div class="in${eyebrows.length ? "" : " noeb"}">${eyebrows.map(block).join("")}<h1>${headline(s.title)}</h1><div class="body">${body(rest)}</div></div>${foot}</section>`;
}

const CSS = `
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:var(--sl-sans);color:var(--sl-ink);background:var(--sl-paper);-webkit-font-smoothing:antialiased}
.slide{position:relative;width:1280px;height:720px;overflow:hidden;background:var(--sl-paper);color:var(--sl-ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.guides{position:absolute;inset:0;pointer-events:none;background:linear-gradient(to right,var(--sl-line) 1px,transparent 1px) 80px 0/280px 100% repeat-x;opacity:.35}
.slide .sl-head{position:absolute;left:80px;right:80px;top:34px;display:flex;flex-direction:column;gap:7px;z-index:1}
.slide .sl-foot{position:absolute;left:80px;bottom:28px;z-index:1}
.slide .in.noeb{padding-top:28px}
.slide .in{position:absolute;left:80px;right:80px;top:116px;bottom:74px;display:flex;flex-direction:column;gap:14px;z-index:1;min-height:0}
h1{margin:0;font-size:42px;line-height:1.08;letter-spacing:-.03em;font-weight:400;max-width:1000px}
h3{margin:0;font-size:20px;line-height:1.25;font-weight:500;letter-spacing:-.01em}
p{margin:0}
.t{font-size:19px;line-height:1.5;color:var(--sl-muted);max-width:900px}
.t.eyebrow{font-size:12px;line-height:1.2;max-width:none;color:var(--sl-ink)}
.t.lead{font-size:24px;line-height:1.4;font-weight:300;letter-spacing:-.01em;color:var(--sl-ink);max-width:880px}
.t.quote{font-size:30px;line-height:1.3;font-weight:300;letter-spacing:-.02em;color:var(--sl-ink);border-left:3px solid var(--sl-mint);padding-left:24px;max-width:960px}
.t.fine{font-size:15px;line-height:1.5;color:var(--sl-muted)}
.body{display:flex;flex-direction:column;gap:18px;min-height:0}
.items{margin:0;padding:0;list-style:none;font-size:19px;line-height:1.4}
.items .tx{color:var(--sl-muted)}
.items.sl-checks{gap:10px}
.items.sl-checks.dense{display:grid;grid-template-columns:1fr 1fr;gap:10px 40px;font-size:18px}
.items.sl-checks li{color:var(--sl-ink)}.items.sl-checks .tx{color:var(--sl-ink)}
.items.rows{display:grid;grid-template-columns:1fr;border-top:1px solid var(--sl-ink)}
.items.rows li{display:grid;grid-template-columns:1fr;column-gap:28px;align-items:baseline;padding:13px 0;border-bottom:1px solid var(--sl-line)}
.items.rows.titled li{grid-template-columns:230px 1fr}
.items.rows strong{font-weight:500;color:var(--sl-ink);letter-spacing:-.01em}
.items.rows.num{counter-reset:n}
.items.rows.num li{counter-increment:n;grid-template-columns:56px 1fr}
.items.rows.num.titled li{grid-template-columns:56px 200px 1fr}
.items.rows.num li::before{content:counter(n,decimal-leading-zero);font:400 13px/1 var(--sl-mono);letter-spacing:.06em;color:var(--sl-green)}
.items.rows.num:not(.titled) li .tx{color:var(--sl-ink)}
.items.rows.dense li{padding:8px 0;font-size:17px}
.items.rows.roomy li{padding:19px 0;font-size:21px}
.items.rows.two{grid-template-columns:1fr 1fr;column-gap:56px;border-top:0}
.items.rows.two li{border-top:0;border-bottom:1px solid var(--sl-line)}
.items.rows.two li:nth-child(-n+2){border-top:1px solid var(--sl-ink)}
.items.rows.two.titled li{grid-template-columns:1fr auto}.items.rows.two.titled .tx{justify-self:end}
.tx.verdict{font:400 12px/1 var(--sl-mono);letter-spacing:.08em;text-transform:uppercase;justify-self:end}
.tx.verdict.pass{color:var(--sl-green)}.tx.verdict.flag{color:var(--sl-ink);background:var(--sl-mist);padding:5px 8px;border:1px solid var(--sl-line)}
.list .lh{color:var(--sl-green);margin-bottom:12px;font-weight:400}
.price{font-size:60px;line-height:1;font-weight:300;letter-spacing:-.04em;color:var(--sl-ink)}.price.long{font-size:32px;line-height:1.2;letter-spacing:-.03em}
.row{display:flex;gap:20px;align-items:stretch}.row>*{flex:1;min-width:0}
.card{margin:0;display:flex;flex-direction:column;gap:8px}
.card img{display:block;width:100%;height:210px;object-fit:cover;object-position:top;border-bottom:1px solid var(--sl-line)}
.card .noimg{display:none}
.card .cap{display:flex;flex-direction:column;gap:7px;padding:16px 20px 20px}
.card .noimg+.cap{padding-top:20px}
.card .sl-label{color:var(--sl-green)}
.card p{font-size:17px;line-height:1.45;color:var(--sl-muted)}
.opt{position:relative;padding:20px 22px 18px;gap:8px}
.opt.rec{padding:22px 21px 19px}
.opt .tag{font-size:16px;color:var(--sl-muted);line-height:1.4}
.opt .badge{position:absolute;top:0;right:0}
.opt h3{font-size:22px;font-weight:400;letter-spacing:-.02em;padding-right:0}
.opt .items{font-size:17px;margin-top:2px;display:flex;flex-direction:column}
.opt .items li{padding:6px 0;border-top:1px solid var(--sl-line)}
.opt .items:not(.inc) li:last-child{border-bottom:1px solid var(--sl-line)}
.opt .items strong{font-weight:500}.opt .items span{display:block;font-size:15px;color:var(--sl-muted);margin-top:1px}
.opt .inc{margin-top:2px;font-size:15px;gap:5px}.opt .inc li{border:0;padding:0 0 0 24px;color:var(--sl-ink)}
.opt .tot{margin-top:auto;padding-top:8px;font-size:23px;line-height:1.2;font-weight:300;letter-spacing:-.02em;color:var(--sl-ink)}
.stat{display:flex;flex-direction:column;gap:10px;position:relative;padding-top:16px;border-top:1px solid var(--sl-ink)}
.stat strong{font-size:84px;line-height:1;font-weight:300;letter-spacing:-.045em;color:var(--sl-ink)}
.stat span:not(.op){font-size:18px;line-height:1.35;color:var(--sl-muted);max-width:280px}
.row.stat>.stat:last-child strong{color:var(--sl-green)}
.stat .op{position:absolute;left:-21px;top:34px;width:22px;text-align:center;font:300 28px/1 var(--sl-sans);color:var(--sl-muted)}
.row.lists{gap:56px}.row.lists .items{font-size:17px}.row.lists .items.sl-checks{gap:8px}.row.lists .items.sl-checks.dense{grid-template-columns:1fr}
.row.stat{flex-direction:row;align-items:flex-start;gap:64px;margin-top:14px;padding:0;border:0}
.row.stat>.stat{flex:1}
.row.stat>.stat .op{left:-43px}
.cover-mark{position:absolute;top:44px;left:0;right:0;text-align:center;z-index:1}
.cover-mark .sl-mark{font-size:26px}
.k-title .in{top:210px;bottom:90px;gap:18px;justify-content:flex-start}
.k-title h1{font-size:92px;font-weight:300;letter-spacing:-.045em;line-height:1;max-width:1100px;margin:6px 0 10px}
.k-title h1.l2{font-size:68px}.k-title h1.l3{font-size:52px;letter-spacing:-.035em}
.k-title .body{gap:10px}
.k-title .t.lead{font-size:28px;color:var(--sl-muted);max-width:900px}
.k-title .t.prep{font-size:20px;color:var(--sl-ink);margin-top:6px}
.k-title .sl-rule{margin:26px 0 10px}
.k-title .meta{font:400 12px/1.3 var(--sl-mono);letter-spacing:.06em;color:var(--sl-muted);text-transform:uppercase}
.k-thanks{background:var(--sl-night);color:#fff}
.k-thanks .guides{background:linear-gradient(to right,#fff 1px,transparent 1px) 80px 0/280px 100% repeat-x;opacity:.07}
.k-thanks .flow{position:absolute;top:190px;color:#fff;z-index:0;line-height:0}.k-thanks .flow.l{left:0}.k-thanks .flow.r{right:0}
.k-thanks .sl-mark{color:#fff}
.k-thanks .sl-foot{color:#8c948f}.k-thanks .sl-foot::before{background:#fff;opacity:.35}
.k-thanks .in{top:0;bottom:0;left:0;right:0;align-items:center;justify-content:center;text-align:center;gap:16px}
.k-thanks h1{font-size:104px;font-weight:300;letter-spacing:-.045em;line-height:1;color:#fff}
.k-thanks .body{align-items:center}
.k-thanks .t.lead{color:#a3aaa5;font-size:24px;text-align:center}
.k-thanks .t.eyebrow{color:#fff}
@page{size:1280px 720px;margin:0}
`;

const SCREEN_CSS = `
html,body{height:100%;overflow:hidden;background:${SITELINE.night}}
#app{display:flex;height:100%}
#stage{position:relative;flex:1;min-width:0;overflow:hidden;cursor:pointer}
.slide{position:absolute;left:0;top:0;transform-origin:0 0;display:none}
.slide.on{display:block}
#bar{position:fixed;right:12px;bottom:10px;z-index:5;color:#b9c0bb;font:400 11px/1 ${SITELINE.mono};letter-spacing:.04em;display:flex;gap:12px;align-items:center;user-select:none;background:rgba(12,15,14,.92);padding:6px 8px}
#bar button{all:unset;cursor:pointer;padding:6px 10px;border:1px solid #3b4440;border-radius:0;color:#fff}
#bar button:hover{border-color:${SITELINE.mint}}
#notes{display:none;width:340px;flex:none;background:${SITELINE.paper};color:${SITELINE.ink};padding:20px;overflow:auto;border-left:1px solid ${SITELINE.line};font-size:15px;line-height:1.5}
#notes.on{display:block}#notes h2{margin:0 0 12px;font:400 11px/1.3 ${SITELINE.mono};letter-spacing:.08em;text-transform:uppercase;color:${SITELINE.green}}#notes p+p{margin-top:10px}
.note{display:none}.note.on{display:block}
`;

const SCRIPT = `(function(){
var slides=[].slice.call(document.querySelectorAll(".slide")),notes=[].slice.call(document.querySelectorAll(".note")),stage=document.getElementById("stage"),panel=document.getElementById("notes"),count=document.getElementById("count"),i=0;
function fit(){var w=stage.clientWidth,h=stage.clientHeight,k=Math.min(w/1280,h/720);slides.forEach(function(s){s.style.transform="scale("+k+")";s.style.left=Math.max(0,(w-1280*k)/2)+"px";s.style.top=Math.max(0,(h-720*k)/2)+"px"})}
function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,j){s.classList.toggle("on",j===i)});notes.forEach(function(s,j){s.classList.toggle("on",j===i)});count.textContent=(i+1)+" / "+slides.length;try{history.replaceState(null,"","#"+(i+1))}catch(e){}}
document.addEventListener("keydown",function(e){var k=e.key;
if(k==="ArrowRight"||k==="ArrowDown"||k==="PageDown"||k===" "){e.preventDefault();show(i+1)}
else if(k==="ArrowLeft"||k==="ArrowUp"||k==="PageUp"){e.preventDefault();show(i-1)}
else if(k==="Home"){show(0)}else if(k==="End"){show(slides.length-1)}
else if(k==="n"||k==="N"){panel.classList.toggle("on");fit()}});
stage.addEventListener("click",function(e){var r=stage.getBoundingClientRect();show(e.clientX-r.left<r.width*0.3?i-1:i+1)});
document.getElementById("prev").addEventListener("click",function(e){e.stopPropagation();show(i-1)});
document.getElementById("next").addEventListener("click",function(e){e.stopPropagation();show(i+1)});
window.addEventListener("resize",fit);
var start=parseInt((location.hash||"").slice(1),10);fit();show(start>0?start-1:0);
})();`;

/**
 * One self-contained HTML document in the Siteline look: inline CSS and script, Geist embedded as `data:` fonts, images only as `data:` URIs, every interpolated value escaped.
 * On screen one slide shows at a time (arrow keys or click to move, `N` toggles the speaker notes). With `print` every slide is a 1280 by 720 page and
 * the notes and the script are not in the document at all. The running header names the document and the client from `opts.title` ("Client - Document").
 */
export function renderDeckHtml(slides: DeckSlide[], opts: { title: string; print: boolean }): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><style>${SITELINE_BASE_CSS}${CSS}${opts.print ? "" : SCREEN_CSS}${
    opts.print ? ".slide{page-break-after:always;break-after:page}" : ""}</style></head>`;
  const ctx = { ...titleParts(opts.title), year: new Date().getFullYear() };
  const all = slides.map((s, i) => slideHtml(s, i + 1, ctx)).join("");
  if (opts.print) return `${head}<body data-print="1">${all}</body></html>`;
  const notes = slides.map((s, i) => `<div class="note" data-n="${i + 1}">${paragraphs(s.speakerNote)}</div>`).join("");
  return `${head}<body><div id="app"><div id="stage">${all}</div><aside id="notes" aria-label="Speaker notes"><h2>Speaker notes</h2>${notes}</aside></div>` +
    `<div id="bar"><button id="prev" type="button">Back</button><span id="count"></span><button id="next" type="button">Next</button><span>Arrow keys or click to move, N for notes</span></div>` +
    `<script>${SCRIPT}</script></body></html>`;
}
