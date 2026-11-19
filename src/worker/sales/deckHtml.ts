import type { DeckBlock, DeckSlide } from "./deck";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** An image source is a `data:` URI or nothing: a deck makes no request of its own. */
const imgSrc = (u: string | null): string | null => (u !== null && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : null);
const paragraphs = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");

function block(b: DeckBlock): string {
  switch (b.type) {
    case "text": return `<p class="t ${b.style ?? ""}">${esc(b.text)}</p>`;
    case "list": return `<div class="list">${b.heading ? `<h3>${esc(b.heading)}</h3>` : ""}<${b.numbered ? "ol" : "ul"} class="items">${
      b.items.map((i) => `<li>${i.title ? `<strong>${esc(i.title)}</strong>` : ""}${i.title ? " " : ""}<span>${esc(i.text)}</span></li>`).join("")}</${b.numbered ? "ol" : "ul"}></div>`;
    case "stat": return `<div class="stat">${b.op ? `<span class="op">${b.op === "times" ? "&times;" : "="}</span>` : ""}<strong>${esc(b.value)}</strong><span>${esc(b.label)}</span></div>`;
    case "price": return `<p class="price">${esc(b.text)}</p>`;
    case "image": {
      const src = imgSrc(b.dataUri);
      return `<figure class="card">${src ? `<img src="${esc(src)}" alt="${esc(b.alt)}">` : `<div class="noimg"></div>`}${b.label ? `<small>${esc(b.label)}</small>` : ""}${
        b.title ? `<h3>${esc(b.title)}</h3>` : ""}${b.text ? `<p>${esc(b.text)}</p>` : ""}</figure>`;
    }
    case "option": return `<div class="card opt${b.recommended ? " rec" : ""}">${b.recommended ? `<small class="badge">Recommended</small>` : ""}<h3>${esc(b.label)}</h3>${
      b.tagline ? `<p class="tag">${esc(b.tagline)}</p>` : ""}<ul class="items">${b.items.map((i) => `<li><strong>${esc(i.name)}</strong> <span>${esc(i.price)}</span></li>`).join("")}</ul>${
      b.includes?.length ? `<ul class="items inc">${b.includes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}<p class="tot">${
      [b.upfront && `${esc(b.upfront)} up front`, b.monthly && esc(b.monthly)].filter(Boolean).join(" + ")}</p></div>`;
  }
}

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
    } else { out.push(block(blocks[i])); i++; }
  }
  return out.join("");
}

function slideHtml(s: DeckSlide, n: number): string {
  const eyebrows = s.blocks.filter((b) => b.type === "text" && b.style === "eyebrow");
  const rest = s.blocks.filter((b) => !(b.type === "text" && b.style === "eyebrow"));
  return `<section class="slide k-${esc(s.key)}" id="s${n}" data-n="${n}"><div class="in">${eyebrows.map(block).join("")}<h1>${esc(s.title)}</h1><div class="body">${body(rest)}</div></div><footer>${n}</footer></section>`;
}

const CSS = `
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#14202b;background:#fff;-webkit-font-smoothing:antialiased}
.slide{position:relative;width:1280px;height:720px;overflow:hidden;background:#fff;padding:64px 80px}
.slide .in{height:100%;display:flex;flex-direction:column;gap:18px}
.slide footer{position:absolute;right:40px;bottom:24px;color:#8a97a3;font-size:16px}
h1{margin:0;font-size:52px;line-height:1.1;letter-spacing:-.02em;font-weight:750}
h3{margin:0 0 6px;font-size:22px;line-height:1.25}
p{margin:0}
.t{font-size:22px;line-height:1.45;color:#34424f;max-width:960px}
.t.eyebrow{font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#1f5fbf;margin-bottom:-6px}
.t.lead{font-size:26px;color:#14202b}.t.quote{font-size:34px;line-height:1.35;font-weight:600;color:#14202b;border-left:6px solid #1f5fbf;padding-left:24px;max-width:1040px}
.t.fine{font-size:18px;color:#5b6b79}
.body{display:flex;flex-direction:column;gap:20px;min-height:0}
.items{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;font-size:21px;line-height:1.4}
ol.items{counter-reset:n}ol.items li{counter-increment:n;position:relative;padding-left:46px}
ol.items li::before{content:counter(n,decimal-leading-zero);position:absolute;left:0;top:1px;font-weight:700;color:#1f5fbf}
.items li strong{font-weight:700}.items li span{color:#34424f}
ul.items:not(.inc) li{padding-left:0}
.list h3{font-size:16px;letter-spacing:.1em;text-transform:uppercase;color:#5b6b79}
.price{font-size:44px;font-weight:750;color:#1f5fbf;letter-spacing:-.01em}
.row{display:flex;gap:24px;align-items:stretch}.row>*{flex:1;min-width:0}
.card{border:1px solid #d9e0e6;border-radius:14px;padding:20px;margin:0;display:flex;flex-direction:column;gap:8px;background:#fff}
.card img{width:100%;height:190px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid #e6ebef}
.card .noimg{display:none}
.card small{font-size:13px;font-weight:700;letter-spacing:.1em;color:#1f5fbf}
.card p{font-size:18px;line-height:1.4;color:#34424f}
.opt.rec{border:2px solid #1f5fbf;background:#f3f8ff}.opt .tag{font-size:16px;color:#5b6b79}
.opt .badge{align-self:flex-start;background:#1f5fbf;color:#fff;border-radius:999px;padding:3px 10px;letter-spacing:.08em;text-transform:uppercase}
.opt .items{font-size:18px;gap:8px}.opt .items span{display:block;font-size:16px;color:#5b6b79}.opt .inc{margin-top:6px;font-size:16px;color:#34424f}
.opt .tot{margin-top:auto;font-size:24px;font-weight:700;color:#14202b}
.stat{display:flex;flex-direction:column;gap:6px;position:relative;padding:8px 12px}
.stat strong{font-size:78px;line-height:1;color:#1f5fbf;letter-spacing:-.02em}.stat span:not(.op){font-size:19px;color:#34424f;max-width:260px}
.stat .op{position:absolute;left:-26px;top:22px;font-size:44px;color:#8a97a3}
.row.stat{gap:56px;margin:12px 0 0 28px}
.k-title{padding-top:210px}.k-title h1{font-size:76px}.k-title .t{font-size:24px}
.k-thanks{padding-top:250px}.k-thanks h1{font-size:76px}
@page{size:1280px 720px;margin:0}
`;

const SCREEN_CSS = `
html,body{height:100%;overflow:hidden;background:#0f1720}
#app{display:flex;height:100%}
#stage{position:relative;flex:1;min-width:0;overflow:hidden;cursor:pointer}
.slide{position:absolute;left:0;top:0;transform-origin:0 0;display:none}
.slide.on{display:block}
#bar{position:fixed;left:12px;bottom:10px;z-index:5;color:#cfd8e0;font:13px/1 system-ui,sans-serif;display:flex;gap:12px;align-items:center;user-select:none}
#bar button{all:unset;cursor:pointer;padding:5px 9px;border:1px solid #3a4856;border-radius:6px}
#notes{display:none;width:340px;flex:none;background:#fff;color:#14202b;padding:20px;overflow:auto;border-left:1px solid #d9e0e6;font-size:15px;line-height:1.5}
#notes.on{display:block}#notes h2{margin:0 0 10px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#5b6b79}#notes p+p{margin-top:10px}
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
 * One self-contained HTML document: inline CSS and script, system fonts, images only as `data:` URIs, every interpolated value escaped.
 * On screen one slide shows at a time (arrow keys or click to move, `N` toggles the speaker notes). With `print` every slide is a 1280 by 720 page and
 * the notes and the script are not in the document at all.
 */
export function renderDeckHtml(slides: DeckSlide[], opts: { title: string; print: boolean }): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><style>${CSS}${opts.print ? "" : SCREEN_CSS}${
    opts.print ? ".slide{page-break-after:always;break-after:page}" : ""}</style></head>`;
  const all = slides.map((s, i) => slideHtml(s, i + 1)).join("");
  if (opts.print) return `${head}<body data-print="1">${all}</body></html>`;
  const notes = slides.map((s, i) => `<div class="note" data-n="${i + 1}">${paragraphs(s.speakerNote)}</div>`).join("");
  return `${head}<body><div id="app"><div id="stage">${all}</div><aside id="notes" aria-label="Speaker notes"><h2>Speaker notes</h2>${notes}</aside></div>` +
    `<div id="bar"><button id="prev" type="button">Back</button><span id="count"></span><button id="next" type="button">Next</button><span>Arrow keys or click to move, N for notes</span></div>` +
    `<script>${SCRIPT}</script></body></html>`;
}
