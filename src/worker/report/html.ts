import type { Audit, AuditCategory, Business, Finding, Settings } from "../types";
import { NICHES } from "../audit/rubrics";
import { esc } from "./esc";
import { renderCroSlides, croCss, croDocSection, type CroReportData } from "./cro";
import { SITELINE, SITELINE_BASE_CSS, flowLinesSvg, footerHtml, runningHeaderHtml, wordmarkHtml } from "../brand/siteline";

/** Everything the client-facing audit deck needs. Screenshots are inlined as data URIs so the HTML is self-contained. */
export interface ReportData {
  business: Business; audit: Audit; settings: Settings; now: Date;
  desktopJpegB64: string | null; mobileJpegB64: string | null;
  cro?: CroReportData | null;
}

const CAT_LABEL: Record<AuditCategory | "site", string> = {
  design: "Design & UX", content: "Content", cro: "Conversion", mobile: "Mobile", speed: "Speed", technical: "Technical & SEO", site: "Website",
};
const CAT_BLURB: Record<AuditCategory | "site", string> = {
  design: "First impressions: does the site look credible, current and easy to scan?",
  content: "Does the site clearly say what you do, for whom, and answer customers' questions?",
  cro: "How easily a visitor becomes a customer: calls, bookings, quotes and enquiries.",
  mobile: "Most local customers visit on a phone. Is it easy to read and tap?",
  speed: "How quickly the site loads on a phone (from Google's own speed test).",
  technical: "The behind-the-scenes basics that help Google and browsers trust the site.",
  site: "Whether customers can find a working website at all.",
};
const ORDER: (AuditCategory | "site")[] = ["site", "design", "content", "cro", "mobile", "speed", "technical"];
const SEV = { critical: "Fix first", important: "Important", nice: "Nice to have" } as const;
const OFFER: Record<string, [string, string]> = {
  new_site: ["A new, modern website", "A fast, mobile-first site built around how your customers buy, with clear calls to action and content you can update."],
  performance: ["Speed & mobile tune-up", "Make the site load fast and work beautifully on phones, without starting from scratch."],
  care_plan: ["Website care plan", "Keep the site current, secure and working, with regular content updates and monitoring."],
  seo_basics: ["Search & trust basics", "Fix the technical basics so Google shows you properly and visitors trust the site."],
  conversion: ["Conversion refresh", "Turn more visitors into calls, bookings and enquiries with clearer actions, proof and contact paths."],
};

const band = (n: number | null) => (n === null ? "none" : n < 40 ? "poor" : n < 70 ? "fair" : "good");

/** Escapes a heading and sets its last word in the Siteline green (one highlighted word per heading). */
function hl(text: string): string {
  const t = esc(text);
  const i = t.lastIndexOf(" ");
  return i < 0 ? `<span class="sl-hl">${t}</span>` : `${t.slice(0, i + 1)}<span class="sl-hl">${t.slice(i + 1)}</span>`;
}

/** Half-circle score gauge: thin ink arc on a hairline track, with a mint dot at the end of the arc. */
function gauge(score: number | null, size = 260) {
  const r = 80, cx = 100, cy = 95, len = Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const theta = Math.PI * (1 - pct);
  const dot = score !== null && pct > 0 ? `<circle cx="${(cx + r * Math.cos(theta)).toFixed(1)}" cy="${(cy - r * Math.sin(theta)).toFixed(1)}" r="6.5" class="end"/>` : "";
  return `<svg class="gauge band-${band(score)}" width="${size}" viewBox="0 0 200 110" role="img" aria-label="Site Health ${score ?? "not measured"} out of 100">
    <path d="${arc}" class="track"/>${score !== null ? `<path d="${arc}" class="fill" stroke-dasharray="${(len * pct).toFixed(1)} ${len.toFixed(1)}"/>` : ""}${dot}
    <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="val">${score ?? "—"}</text></svg>`;
}

/**
 * Splits a category's findings into slides: at most 5, and fewer when the text is long enough to run past the footer.
 * Row height is estimated from the line counts at the issue list's width (about 100 characters a line for the evidence, 125 for the fix).
 */
function paginate(list: Finding[], max = 5, budget = 420): Finding[][] {
  const rowHeight = (f: Finding) => 26 + Math.ceil(f.evidence.length / 100) * 23 + (f.recommendation ? 4 + Math.ceil(f.recommendation.length / 125) * 20 : 0);
  const pages: Finding[][] = [];
  let page: Finding[] = [], used = 0;
  for (const f of list) {
    const h = rowHeight(f);
    if (page.length && (page.length >= max || used + h > budget)) { pages.push(page); page = []; used = 0; }
    page.push(f); used += h;
  }
  if (page.length) pages.push(page);
  return pages;
}

export function renderReport(d: ReportData): string {
  const { business: b, audit: a, settings: s } = d;
  const from = s.business_name || s.your_name || "Your web partner";
  const date = d.now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const niche = a.niche && NICHES[a.niche] ? NICHES[a.niche] : null;
  const findings = a.findings;
  const slides: string[] = [];
  const counts = { critical: 0, important: 0, nice: 0 } as Record<Finding["severity"], number>;
  for (const f of findings) counts[f.severity]++;

  // 1. Cover: centred wordmark, large title left, hairline rule, small grey line, confidentiality note at the foot.
  const longName = b.name.length > 26 ? " long" : "";
  slides.push(`<section class="slide cover">
    ${wordmarkHtml()}
    <div class="cover-body">
      <p class="sl-eyebrow eyebrow">Website audit &amp; proposal</p>
      <h1 class="${longName.trim()}">${esc(b.name)}</h1>
      <p class="sub">${esc([b.category, b.address].filter(Boolean).join(" · "))}</p>
      <p class="site">${esc((b.website_url ?? "").replace(/^https?:\/\//, ""))}</p>
      <hr class="sl-rule"/>
      <p class="prepared">Prepared by ${esc(from)} · ${esc(date)}</p>
    </div>
    <div class="cover-gauge sl-card">${gauge(a.health_score, 280)}<p class="sl-label">Site Health</p></div>
    <footer class="cover-foot">Confidential. Prepared for ${esc(b.name)} by ${esc(from)}. Please do not share this report without permission.</footer>
  </section>`);

  // 2. Scorecard
  const cats = (Object.keys(CAT_LABEL) as AuditCategory[]).filter((c) => c !== ("site" as string) && a.category_scores[c] !== undefined);
  slides.push(`<section class="slide">
    <h2><span class="t">${hl("Your scorecard")}</span></h2>
    <div class="score-grid">
      <div class="score-left"><div class="sl-card gauge-card">${gauge(a.health_score, 260)}<p class="sl-label">Site Health</p></div>
        <p class="lede">${a.health_score === null ? "We couldn't measure this site." : a.health_score >= 70 ? "A solid site with some clear wins available." : a.health_score >= 40 ? "Workable, but it's leaving customers on the table." : "The site is likely costing you customers today."}</p>
        <div class="counts"><span class="c critical">${counts.critical} fix first</span><span class="c important">${counts.important} important</span><span class="c nice">${counts.nice} nice to have</span></div>
      </div>
      <ul class="bars">${cats.map((c) => `<li class="cat-${c}"><span class="name">${CAT_LABEL[c]}</span><span class="track"><span style="width:${a.category_scores[c]}%"></span></span><span class="num">${a.category_scores[c]}</span><span class="blurb">${CAT_BLURB[c]}</span></li>`).join("")}</ul>
    </div>
  </section>`);

  // 3. First impressions: screenshots + what works
  if (d.desktopJpegB64 || d.mobileJpegB64 || a.ai_review) {
    const r = a.ai_review;
    slides.push(`<section class="slide">
      <h2><span class="t">${hl("First impressions")}</span></h2>
      <div class="impressions">
        <div class="shots">
          ${d.desktopJpegB64 ? `<figure class="desk"><img src="data:image/jpeg;base64,${d.desktopJpegB64}" alt="Desktop homepage"/><figcaption>Desktop</figcaption></figure>` : ""}
          ${d.mobileJpegB64 ? `<figure class="phone"><img src="data:image/jpeg;base64,${d.mobileJpegB64}" alt="Phone homepage"/><figcaption>Phone</figcaption></figure>` : ""}
        </div>
        <div class="notes">
          ${r?.value_proposition ? `<p class="quote">“${esc(r.value_proposition)}”</p><p class="muted">What a visitor takes away from your homepage</p>` : ""}
          ${r?.strengths.length ? `<h3>What's working</h3><ul class="good">${r.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
          ${r ? `<h3>Design</h3><p>${esc(r.summaries.design)}</p>` : ""}
        </div>
      </div>
    </section>`);
  }

  // 4. Every issue, grouped by category, up to 5 per slide (fewer when the text is long)
  for (const c of ORDER) {
    const list = findings.filter((f) => f.category === c);
    if (!list.length) continue;
    paginate(list).forEach((part, i, all) => slides.push(`<section class="slide cat-${c}">
      <h2><span class="t">${hl(CAT_LABEL[c])}${all.length > 1 ? ` <span class="muted">(${i + 1}/${all.length})</span>` : ""}</span>${a.category_scores[c as AuditCategory] !== undefined ? `<span class="pill">${a.category_scores[c as AuditCategory]}/100</span>` : ""}</h2>
      <p class="blurb">${CAT_BLURB[c]}</p>
      <ol class="issues">${part.map((f) => `<li class="sev-${f.severity}"><span class="sev">${SEV[f.severity]}</span><div><p class="ev">${esc(f.evidence)}</p>${f.recommendation ? `<p class="fix">${esc(f.recommendation)}</p>` : ""}</div></li>`).join("")}</ol>
    </section>`));
  }

  // 5. Niche checklist
  const checklist = a.ai_review?.niche_checklist ?? [];
  if (niche || checklist.length) {
    slides.push(`<section class="slide">
      <h2><span class="t">${hl(`What a ${niche?.label.toLowerCase() ?? "local business"} website needs`)}</span></h2>
      ${niche ? `<p class="blurb">For a business like yours, the website's job is <strong>${esc(niche.goal.toLowerCase())}</strong>. Here's how yours stacks up.</p>` : ""}
      <ul class="checklist">
        ${checklist.map((x) => `<li class="${x.present ? "yes" : "no"}"><span>${x.present ? "✓" : "✗"}</span>${esc(x.item)}</li>`).join("")}
        ${!checklist.length && niche ? niche.expects.map((x) => `<li class="todo"><span>•</span>${esc(x)}</li>`).join("") : ""}
      </ul>
    </section>`);
  }

  if (d.cro) slides.push(...renderCroSlides(d.cro));

  // 6. Proposal + next steps: the one dark block, with the flow-lines graphic inside it.
  const [offerTitle, offerText] = OFFER[a.offer] ?? OFFER.care_plan;
  const plan = findings.filter((f) => f.severity !== "nice" && f.recommendation).slice(0, 6);
  slides.push(`<section class="slide proposal">
    <p class="sl-eyebrow eyebrow">Recommended next step</p>
    <h2><span class="t">${hl(offerTitle)}</span></h2>
    <p class="lede">${esc(offerText)}</p>
    ${plan.length ? `<h3>What we'd fix first</h3><ol class="plan">${plan.map((f) => `<li>${esc(f.recommendation)}</li>`).join("")}</ol>` : ""}
    <div class="contact sl-dark">
      <div class="who"><strong>${esc(s.your_name || from)}</strong>${s.business_name && s.your_name ? ` · ${esc(s.business_name)}` : ""}
      ${s.contact_email ? `<br/>${esc(s.contact_email)}` : ""}</div>
      ${flowLinesSvg({ width: 340, height: 108, dir: "left", lines: 11, opacity: 0.4 })}
    </div>
  </section>`);

  // Frame every slide after the cover with the running header and the page footer (Third and Grove style).
  const head = runningHeaderHtml({ document: "Website audit", client: b.name, contact: s.contact_email || SITELINE.site });
  const year = d.now.getFullYear();
  const framed = slides.map((html, i) => i === 0 ? html
    : html.replace(/^(\s*<section[^>]*>)/, `$1${head}`).replace(/<\/section>\s*$/, `${footerHtml({ page: i + 1, year })}</section>`));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(b.name)}: website audit</title><style>${SITELINE_BASE_CSS}${CSS}${d.cro ? croCss(d.cro) : ""}</style></head><body>${framed.join("\n")}</body></html>`;
}

// Siteline look: paper, ink, mint accent, square corners, hairlines. The old names (--brand, --good, --soft ...) stay as aliases
// because the conversion chapter's own CSS (report/cro.ts) uses them; the `.slide.cro` rules below restyle that chapter on top of it.
const CSS = `
:root { --ink:var(--sl-ink); --muted:var(--sl-muted); --paper:var(--sl-paper); --soft:var(--sl-mist); --line:var(--sl-line);
  --brand:var(--sl-green); --brand2:var(--sl-ink); --brand3:var(--sl-mint);
  --good:#0a7a55; --fair:#b7791f; --poor:#b3261e; --none:#8a948d;
  --sev-critical:#b3261e; --sev-important:#cf8a0c; --sev-nice:#8a948d;
  --cat-design:var(--sl-ink); --cat-content:var(--sl-ink); --cat-cro:var(--sl-ink); --cat-mobile:var(--sl-ink); --cat-speed:var(--sl-ink); --cat-technical:var(--sl-ink); --cat-site:var(--sl-ink);
  --font:var(--sl-sans); }
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--sl-mist); font-family:var(--font); color:var(--ink); -webkit-print-color-adjust:exact; print-color-adjust:exact; -webkit-font-smoothing:antialiased; }
.slide { position:relative; width:1280px; height:720px; margin:24px auto; padding:108px 80px 76px; background:var(--paper); overflow:hidden; border:1px solid var(--line); border-radius:0; page-break-after:always; break-after:page; font-size:17px; line-height:1.5; }
@media print { html, body { background:none; } .slide { margin:0; border:0; } }
h1 { font-weight:300; font-size:72px; line-height:1.02; margin:0 0 18px; letter-spacing:-.04em; }
h1.long { font-size:54px; }
h2 { font-weight:300; font-size:40px; line-height:1.08; letter-spacing:-.035em; margin:0 0 10px; display:flex; align-items:baseline; justify-content:space-between; gap:24px; }
h2 .t { min-width:0; }
h3 { font:400 12px/1.3 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:22px 0 8px; }
p { margin:0; } .muted { color:var(--muted); font-weight:400; }
h2 .muted { font-size:.55em; letter-spacing:0; }
.eyebrow { display:flex; align-items:center; gap:8px; font:400 12px/1.2 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink); margin-bottom:18px; }
.eyebrow::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--sl-green); flex:none; }
.lede { font-size:21px; line-height:1.45; color:var(--muted); max-width:760px; letter-spacing:-.01em; }
.blurb { font-size:17px; color:var(--muted); margin-bottom:20px; max-width:820px; }
.blurb strong { color:var(--ink); font-weight:500; }

/* running header and footer */
.sl-head { position:absolute; top:34px; left:80px; right:80px; display:grid; grid-template-columns:auto 1fr auto; align-items:center; padding-bottom:14px; border-bottom:1px solid var(--line); }
.sl-head .sl-run { display:contents; }
.sl-head .sl-mark { grid-column:1; grid-row:1; font-size:19px; }
.sl-head .sl-doc { grid-column:2; grid-row:1; padding-left:36px; font-size:13px; }
.sl-head .sl-contact { grid-column:3; grid-row:1; font-size:11px; }
.slide > .sl-foot { position:absolute; left:80px; bottom:28px; }

/* cover */
.cover { padding:0 80px; display:grid; grid-template-columns:1fr 340px; column-gap:72px; align-items:center; }
.cover > .sl-mark { position:absolute; top:52px; left:50%; transform:translateX(-50%); font-size:28px; }
.cover-body { padding-top:36px; }
.cover .sub { font-size:22px; line-height:1.35; color:var(--muted); letter-spacing:-.01em; }
.cover .site { font:400 13px/1.3 var(--sl-mono); letter-spacing:.06em; color:var(--sl-green); margin-top:12px; }
.cover .sl-rule { margin:30px 0 12px; }
.cover .prepared { font-size:13px; color:var(--muted); }
.cover-gauge { padding:30px 24px 22px; text-align:center; margin-top:36px; }
.cover-gauge .gauge { display:block; margin:0 auto 6px; }
.cover-foot { position:absolute; left:80px; right:80px; bottom:40px; font:400 10px/1.5 var(--sl-mono); letter-spacing:.04em; color:var(--muted); }
.cover-foot::before { content:""; display:block; width:96px; height:1px; background:var(--ink); opacity:.35; margin-bottom:10px; }

/* score visuals: ink on hairline, mint end dot */
.gauge .track, .gauge .fill { fill:none; stroke-width:10; stroke-linecap:butt; } .gauge .track { stroke:var(--line); } .gauge .fill { stroke:var(--ink); }
.gauge .end { fill:var(--sl-mint); stroke:var(--ink); stroke-width:1.5; }
.gauge .val { font:300 54px var(--sl-sans); letter-spacing:-.04em; fill:var(--ink); }
.score-grid { display:grid; grid-template-columns:330px 1fr; gap:56px; margin-top:22px; }
.gauge-card { padding:26px 20px 18px; text-align:center; }
.gauge-card .gauge { display:block; margin:0 auto 4px; }
.score-left .lede { font-size:18px; margin-top:20px; }
.counts { display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin-top:16px; }
.c { display:inline-flex; align-items:center; gap:8px; padding:5px 10px; background:var(--sl-card); border:1px solid var(--line); font:400 11px/1.2 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; }
.c::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--sev-nice); }
.c.critical::before { background:var(--sev-critical); } .c.important::before { background:var(--sev-important); }
.bars { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
.bars li { display:grid; grid-template-columns:170px 1fr 52px; grid-template-rows:auto auto; column-gap:18px; align-items:center; padding-bottom:12px; border-bottom:1px solid var(--line); }
.bars li:last-child { border-bottom:0; }
.bars .name { font-weight:500; font-size:17px; letter-spacing:-.01em; } .bars .num { font:400 18px/1 var(--sl-mono); text-align:right; }
.bars .track { height:6px; background:var(--line); } .bars .track > span { display:block; height:100%; background:var(--ink); box-shadow:inset -3px 0 0 var(--sl-mint); }
.bars .blurb { grid-column:1 / -1; font-size:13px; line-height:1.4; margin:6px 0 0; color:var(--muted); }
.cat-design, .cat-content, .cat-cro, .cat-mobile, .cat-speed, .cat-technical, .cat-site { --cat-color:var(--sl-ink); }

/* first impressions */
.impressions { display:grid; grid-template-columns:auto 1fr; gap:48px; margin-top:20px; }
.shots { display:flex; gap:18px; align-items:flex-start; }
.shots figure { margin:0; } .shots img { display:block; border:1px solid var(--ink); object-fit:cover; object-position:top; background:var(--sl-card); }
.shots .desk img { width:420px; height:400px; } .shots .phone img { width:170px; height:400px; }
.shots figcaption { font:400 11px/1.3 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-top:8px; }
.quote { font-size:25px; font-weight:300; line-height:1.3; letter-spacing:-.025em; padding-left:18px; border-left:2px solid var(--sl-green); margin-bottom:8px; }
.notes .muted { padding-left:20px; font-size:14px; }
.notes p { font-size:16px; line-height:1.55; } .notes h3:first-child { margin-top:0; }
ul.good { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:7px; font-size:16px; line-height:1.45; }
ul.good li { position:relative; padding-left:24px; }
ul.good li::before { content:""; position:absolute; left:2px; top:.45em; width:10px; height:5px; border-left:1.6px solid var(--sl-green); border-bottom:1.6px solid var(--sl-green); transform:rotate(-45deg); }

/* findings */
h2 .pill { flex:none; font:400 13px/1 var(--sl-mono); letter-spacing:.06em; padding:7px 10px; border:1px solid var(--ink); background:var(--sl-card); color:var(--ink); }
.slide[class*="cat-"] .blurb { margin-top:4px; }
.issues { list-style:none; margin:0; padding:0; background:var(--sl-card); border:1px solid var(--line); }
.issues li { display:grid; grid-template-columns:130px 1fr; gap:20px; padding:12px 20px 12px 18px; border-bottom:1px solid var(--line); border-left:3px solid var(--sev-nice); }
.issues li:last-child { border-bottom:0; }
.issues li.sev-critical { border-left-color:var(--sev-critical); } .issues li.sev-important { border-left-color:var(--sev-important); }
.issues .sev { align-self:start; display:inline-flex; align-items:center; gap:8px; padding-top:4px; font:400 10px/1.2 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink); }
.issues .sev::before { content:""; width:7px; height:7px; border-radius:50%; flex:none; background:var(--sev-nice); }
.sev-critical .sev::before { background:var(--sev-critical); } .sev-important .sev::before { background:var(--sev-important); }
.issues .ev { font-size:16px; font-weight:500; line-height:1.4; letter-spacing:-.005em; } .issues .fix { font-size:14px; line-height:1.4; color:var(--muted); margin-top:3px; }
.issues .fix::before { content:"→ "; color:var(--sl-green); font-weight:600; }

/* niche checklist */
.checklist { list-style:none; margin:14px 0 0; padding:0; display:grid; grid-template-columns:1fr 1fr; gap:10px 24px; }
.checklist li { display:flex; gap:14px; align-items:center; font-size:17px; font-weight:500; letter-spacing:-.005em; padding:12px 16px; background:var(--sl-card); border:1px solid var(--line); }
.checklist li span { width:26px; height:26px; flex:none; display:grid; place-items:center; border:1px solid currentColor; font:600 14px/1 var(--sl-sans); }
.checklist .yes span { color:var(--good); } .checklist .no span { color:var(--poor); } .checklist .todo span { color:var(--muted); }

/* proposal */
.proposal .lede { max-width:660px; }
.proposal .plan { margin:0; padding:0; list-style:none; columns:2; column-gap:56px; counter-reset:p; font-size:16px; line-height:1.45; }
.proposal .plan li { counter-increment:p; position:relative; padding:0 0 14px 38px; break-inside:avoid; }
.proposal .plan li::before { content:counter(p, decimal-leading-zero); position:absolute; left:0; top:.2em; font:400 12px/1 var(--sl-mono); letter-spacing:.06em; color:var(--sl-green); }
.proposal h3 { margin-top:52px; }
.proposal .contact { position:absolute; right:80px; top:108px; width:340px; height:190px; padding:24px 26px; background:var(--sl-night); color:#fff; font-size:16px; line-height:1.5; overflow:hidden; }
.proposal .contact .who { position:relative; z-index:1; }
.proposal .contact strong { font-weight:500; font-size:18px; }
.proposal .contact svg { position:absolute; left:0; bottom:8px; color:#fff; }

/* conversion chapter (markup and base CSS live in report/cro.ts; restyled here, higher specificity so it wins) */
.slide.cro h2 { display:block; }
.slide.cro h2 .pill { display:inline-block; vertical-align:middle; margin-left:14px; background:var(--sl-card); color:var(--ink); }
.slide.cro h3 { font:400 12px/1.3 var(--sl-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:16px 0 6px; }
.slide.cro .eyebrow { margin-bottom:14px; }
.slide.cro .cro-grid { gap:56px; margin-top:20px; }
.slide.cro .cro-big { font-size:30px; font-weight:300; letter-spacing:-.03em; line-height:1.15; margin:6px 0 12px; }
.slide.cro .cro-quote { font-size:21px; font-weight:300; line-height:1.4; letter-spacing:-.015em; padding-left:16px; border-left:2px solid var(--line); }
.slide.cro .cro-quote.good { color:var(--ink); font-weight:400; border-left-color:var(--sl-green); }
.slide.cro .cro-list { list-style:none; margin:16px 0 0; padding:0; display:flex; flex-direction:column; gap:12px; font-size:20px; line-height:1.4; max-width:960px; }
.slide.cro .cro-list li { position:relative; padding-left:30px; }
.slide.cro .cro-list li::before { content:""; position:absolute; left:2px; top:.5em; width:11px; height:6px; border-left:1.8px solid var(--sl-green); border-bottom:1.8px solid var(--sl-green); transform:rotate(-45deg); }
.slide.cro .cro-item-grid { gap:40px; font-size:17px; line-height:1.45; }
.slide.cro .cro-item-grid p { color:var(--ink); }
.slide.cro .cro-wcd { margin-top:16px; padding:12px 16px; background:var(--sl-card); border:1px solid var(--line); border-left:3px solid var(--sl-green); border-radius:0; font-weight:500; }
.slide .cro-crop { border-radius:0; border:1px solid var(--ink); box-shadow:none; background-color:var(--sl-card); }
.slide .cro-pin { background:var(--sl-ink); color:var(--sl-mint); box-shadow:0 0 0 4px rgba(0,229,160,.35); font-family:var(--sl-mono); font-weight:400; }
.slide.cro .cro-cols { gap:40px; font-size:17px; line-height:1.45; margin-top:20px; }
.slide.cro .cro-cols > div { background:var(--sl-card); border:1px solid var(--line); padding:4px 22px 18px; }
.slide.cro .cro-cols ol { margin:0; padding-left:22px; } .slide.cro .cro-cols li { margin-bottom:6px; } .slide.cro .cro-cols li::marker { font-family:var(--sl-mono); font-size:13px; color:var(--sl-green); }
.slide.cro .cro-table { border-collapse:collapse; font-size:17px; width:100%; background:var(--sl-card); border:1px solid var(--line); }
.slide.cro .cro-table td { padding:9px 20px; border-bottom:1px solid var(--line); }
.slide.cro .cro-table td:first-child { width:260px; font-family:var(--sl-mono); font-size:14px; }
.slide.cro .small { font-size:13px; margin-top:28px; }
.slide.cro .cro-list + p { margin-top:22px; }
.slide.cro p + p { margin-top:6px; }
`;

/** Plain, semantic version of the report for Google Docs import (Docs ignores slide layout CSS). */
export function renderDoc(d: ReportData, email: { subject: string; body: string } | null): string {
  const { business: b, audit: a, settings: s } = d;
  const niche = a.niche && NICHES[a.niche] ? NICHES[a.niche] : null;
  const cats = (Object.keys(CAT_LABEL) as AuditCategory[]).filter((c) => a.category_scores[c] !== undefined);
  const [offerTitle, offerText] = OFFER[a.offer] ?? OFFER.care_plan;
  const section = (c: AuditCategory | "site") => {
    const list = a.findings.filter((f) => f.category === c);
    return list.length ? `<h3>${CAT_LABEL[c]}${a.category_scores[c as AuditCategory] !== undefined ? ` (${a.category_scores[c as AuditCategory]}/100)` : ""}</h3>
      <ul>${list.map((f) => `<li><b>${SEV[f.severity]}:</b> ${esc(f.evidence)}${f.recommendation ? `<br/><i>Fix: ${esc(f.recommendation)}</i>` : ""}</li>`).join("")}</ul>` : "";
  };
  return `<html><head><meta charset="utf-8"/></head><body>
<h1>${esc(b.name)}: website audit &amp; proposal</h1>
<p>${esc([b.category, b.address, b.website_url].filter(Boolean).join(" · "))}<br/>Prepared by ${esc(s.business_name || s.your_name)} · ${esc(d.now.toDateString())}</p>
<h2>Site Health: ${a.health_score ?? "not measured"}/100</h2>
<table border="1" cellpadding="6"><tr><th>Area</th><th>Score</th></tr>${cats.map((c) => `<tr><td>${CAT_LABEL[c]}</td><td>${a.category_scores[c]}</td></tr>`).join("")}</table>
${a.ai_review?.value_proposition ? `<p><i>What visitors take away: “${esc(a.ai_review.value_proposition)}”</i></p>` : ""}
${a.ai_review?.strengths.length ? `<h2>What's working</h2><ul>${a.ai_review.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
<h2>Everything we found</h2>${ORDER.map(section).join("")}
${a.ai_review?.niche_checklist.length ? `<h2>What a ${esc(niche?.label.toLowerCase() ?? "business")} website needs</h2><ul>${a.ai_review.niche_checklist.map((x) => `<li>${x.present ? "✓" : "✗"} ${esc(x.item)}</li>`).join("")}</ul>` : ""}
${d.cro ? croDocSection(d.cro) : ""}
<h2>Recommended next step: ${esc(offerTitle)}</h2><p>${esc(offerText)}</p>
${email ? `<h2>Outreach email draft</h2><p><b>Subject:</b> ${esc(email.subject)}</p><p>${esc(email.body).replace(/\n/g, "<br/>")}</p>` : ""}
</body></html>`;
}
