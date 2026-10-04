import type { Audit, AuditCategory, Business, Finding, Settings } from "../types";
import { NICHES } from "../audit/rubrics";

/** Everything the client-facing audit deck needs. Screenshots are inlined as data URIs so the HTML is self-contained. */
export interface ReportData {
  business: Business; audit: Audit; settings: Settings; now: Date;
  desktopJpegB64: string | null; mobileJpegB64: string | null;
}

const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

function gauge(score: number | null, size = 260) {
  const r = 80, cx = 100, cy = 95, len = Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return `<svg class="gauge band-${band(score)}" width="${size}" viewBox="0 0 200 110" role="img" aria-label="Site Health ${score ?? "not measured"} out of 100">
    <path d="${arc}" class="track"/>${score !== null ? `<path d="${arc}" class="fill" stroke-dasharray="${(len * pct).toFixed(1)} ${len.toFixed(1)}"/>` : ""}
    <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="val">${score ?? "—"}</text></svg>`;
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function renderReport(d: ReportData): string {
  const { business: b, audit: a, settings: s } = d;
  const from = s.business_name || s.your_name || "Your web partner";
  const date = d.now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const niche = a.niche && NICHES[a.niche] ? NICHES[a.niche] : null;
  const findings = a.findings;
  const slides: string[] = [];
  const counts = { critical: 0, important: 0, nice: 0 } as Record<Finding["severity"], number>;
  for (const f of findings) counts[f.severity]++;

  // 1. Cover
  slides.push(`<section class="slide cover">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="cover-body">
      <p class="eyebrow">Website audit &amp; proposal</p>
      <h1>${esc(b.name)}</h1>
      <p class="sub">${esc([b.category, b.address].filter(Boolean).join(" · "))}</p>
      <p class="site">${esc((b.website_url ?? "").replace(/^https?:\/\//, ""))}</p>
    </div>
    <div class="cover-gauge">${gauge(a.health_score, 300)}<p>Site Health</p></div>
    <footer>Prepared by ${esc(from)} · ${esc(date)}</footer>
  </section>`);

  // 2. Scorecard
  const cats = (Object.keys(CAT_LABEL) as AuditCategory[]).filter((c) => c !== ("site" as string) && a.category_scores[c] !== undefined);
  slides.push(`<section class="slide">
    <h2>Your scorecard</h2>
    <div class="score-grid">
      <div class="score-left">${gauge(a.health_score, 280)}
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
      <h2>First impressions</h2>
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

  // 4. Every issue, grouped by category, 5 per slide
  for (const c of ORDER) {
    const list = findings.filter((f) => f.category === c);
    if (!list.length) continue;
    chunk(list, 5).forEach((part, i, all) => slides.push(`<section class="slide cat-${c}">
      <h2><span class="dot"></span>${CAT_LABEL[c]}${all.length > 1 ? ` <span class="muted">(${i + 1}/${all.length})</span>` : ""}${a.category_scores[c as AuditCategory] !== undefined ? `<span class="pill">${a.category_scores[c as AuditCategory]}/100</span>` : ""}</h2>
      <p class="blurb">${CAT_BLURB[c]}</p>
      <ol class="issues">${part.map((f) => `<li class="sev-${f.severity}"><span class="sev">${SEV[f.severity]}</span><div><p class="ev">${esc(f.evidence)}</p>${f.recommendation ? `<p class="fix">${esc(f.recommendation)}</p>` : ""}</div></li>`).join("")}</ol>
    </section>`));
  }

  // 5. Niche checklist
  const checklist = a.ai_review?.niche_checklist ?? [];
  if (niche || checklist.length) {
    slides.push(`<section class="slide">
      <h2>What a ${esc(niche?.label.toLowerCase() ?? "local business")} website needs</h2>
      ${niche ? `<p class="blurb">For a business like yours, the website's job is <strong>${esc(niche.goal.toLowerCase())}</strong>. Here's how yours stacks up.</p>` : ""}
      <ul class="checklist">
        ${checklist.map((x) => `<li class="${x.present ? "yes" : "no"}"><span>${x.present ? "✓" : "✗"}</span>${esc(x.item)}</li>`).join("")}
        ${!checklist.length && niche ? niche.expects.map((x) => `<li class="todo"><span>•</span>${esc(x)}</li>`).join("") : ""}
      </ul>
    </section>`);
  }

  // 6. Proposal + next steps
  const [offerTitle, offerText] = OFFER[a.offer] ?? OFFER.care_plan;
  const plan = findings.filter((f) => f.severity !== "nice" && f.recommendation).slice(0, 6);
  slides.push(`<section class="slide proposal">
    <div class="blob b1"></div><div class="blob b2"></div>
    <p class="eyebrow">Recommended next step</p>
    <h2>${esc(offerTitle)}</h2>
    <p class="lede">${esc(offerText)}</p>
    ${plan.length ? `<h3>What we'd fix first</h3><ol class="plan">${plan.map((f) => `<li>${esc(f.recommendation)}</li>`).join("")}</ol>` : ""}
    <div class="contact">
      <strong>${esc(s.your_name || from)}</strong>${s.business_name && s.your_name ? ` · ${esc(s.business_name)}` : ""}
      ${s.contact_email ? `<br/>${esc(s.contact_email)}` : ""}
    </div>
  </section>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(b.name)}: website audit</title><style>${CSS}</style></head><body>${slides.join("\n")}</body></html>`;
}

// Bright, colorful deck styling. Tokens up top so a brand system can re-skin it.
const CSS = `
:root { --ink:#16132b; --muted:#6b6880; --paper:#ffffff; --soft:#f6f4ff; --line:#e9e6f5;
  --brand:#6d4aff; --brand2:#ff5ca8; --brand3:#20c4b0; --sun:#ffb020;
  --good:#16a34a; --fair:#f59e0b; --poor:#ef4444; --none:#a8a29e;
  --sev-critical:#ef4444; --sev-important:#f59e0b; --sev-nice:#3b82f6;
  --cat-design:#8b5cf6; --cat-content:#0ea5e9; --cat-cro:#ec4899; --cat-mobile:#14b8a6; --cat-speed:#f97316; --cat-technical:#6366f1; --cat-site:#64748b;
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; }
html, body { margin:0; background:#d9d6e8; font-family:var(--font); color:var(--ink); -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.slide { position:relative; width:1280px; height:720px; margin:24px auto; padding:64px 80px; background:var(--paper); overflow:hidden; border-radius:18px; box-shadow:0 10px 40px rgba(22,19,43,.15); page-break-after:always; break-after:page; }
@media print { html, body { background:none; } .slide { margin:0; border-radius:0; box-shadow:none; } }
h1 { font-size:76px; line-height:1.02; margin:0 0 16px; letter-spacing:-.02em; }
h2 { font-size:44px; margin:0 0 12px; letter-spacing:-.01em; display:flex; align-items:center; gap:14px; }
h3 { font-size:20px; margin:22px 0 8px; }
p { margin:0; } .muted { color:var(--muted); font-weight:500; }
.eyebrow { text-transform:uppercase; letter-spacing:.14em; font-weight:800; font-size:16px; color:var(--brand); margin-bottom:18px; }
.lede { font-size:24px; line-height:1.4; color:var(--muted); max-width:820px; }
.blurb { font-size:20px; color:var(--muted); margin-bottom:24px; }
.blob { position:absolute; border-radius:50%; filter:blur(2px); opacity:.9; }
.b1 { width:520px; height:520px; right:-160px; top:-180px; background:radial-gradient(circle at 30% 30%, var(--brand2), var(--brand)); }
.b2 { width:300px; height:300px; right:300px; bottom:-170px; background:radial-gradient(circle at 30% 30%, var(--sun), var(--brand2)); }
.b3 { width:180px; height:180px; left:-60px; bottom:-40px; background:radial-gradient(circle, var(--brand3), #0ea5e9); }
.cover { background:linear-gradient(135deg, #fff 55%, var(--soft)); display:grid; grid-template-columns:1fr 360px; align-items:center; }
.cover-body, .cover-gauge, .cover footer { position:relative; z-index:1; }
.cover .sub { font-size:24px; color:var(--muted); } .cover .site { font-size:20px; font-weight:700; color:var(--brand); margin-top:10px; }
.cover-gauge { background:rgba(255,255,255,.88); border-radius:28px; padding:24px 24px 18px; text-align:center; box-shadow:0 20px 50px rgba(109,74,255,.25); }
.cover-gauge p { font-weight:800; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); margin-top:-4px; }
.cover footer { position:absolute; left:80px; bottom:48px; font-size:18px; color:var(--muted); font-weight:600; }
.gauge .track, .gauge .fill { fill:none; stroke-width:18; stroke-linecap:round; } .gauge .track { stroke:var(--line); }
.gauge .fill { stroke:var(--none); } .band-good .fill { stroke:var(--good); } .band-fair .fill { stroke:var(--fair); } .band-poor .fill { stroke:var(--poor); }
.gauge .val { font-size:46px; font-weight:900; fill:var(--ink); }
.score-grid { display:grid; grid-template-columns:330px 1fr; gap:48px; margin-top:20px; }
.score-left .lede { font-size:20px; margin-top:8px; }
.counts { display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
.c { padding:6px 14px; border-radius:99px; font-weight:800; font-size:15px; color:#fff; }
.c.critical { background:var(--sev-critical); } .c.important { background:var(--sev-important); } .c.nice { background:var(--sev-nice); }
.bars { list-style:none; margin:0; padding:0; display:grid; gap:14px; }
.bars li { display:grid; grid-template-columns:190px 1fr 56px; grid-template-rows:auto auto; column-gap:16px; align-items:center; }
.bars .name { font-weight:800; font-size:20px; } .bars .num { font-weight:900; font-size:24px; text-align:right; }
.bars .track { height:16px; border-radius:99px; background:var(--soft); overflow:hidden; } .bars .track > span { display:block; height:100%; border-radius:99px; background:var(--cat-color); }
.bars .blurb { grid-column:1 / -1; font-size:14px; margin:2px 0 0; }
.cat-design { --cat-color:var(--cat-design); } .cat-content { --cat-color:var(--cat-content); } .cat-cro { --cat-color:var(--cat-cro); }
.cat-mobile { --cat-color:var(--cat-mobile); } .cat-speed { --cat-color:var(--cat-speed); } .cat-technical { --cat-color:var(--cat-technical); } .cat-site { --cat-color:var(--cat-site); }
.impressions { display:grid; grid-template-columns:auto 1fr; gap:40px; margin-top:16px; }
.shots { display:flex; gap:18px; align-items:flex-start; }
.shots figure { margin:0; } .shots img { display:block; border-radius:12px; border:1px solid var(--line); object-fit:cover; object-position:top; box-shadow:0 12px 30px rgba(22,19,43,.12); }
.shots .desk img { width:440px; height:500px; } .shots .phone img { width:170px; height:500px; border-radius:22px; border:6px solid var(--ink); }
.shots figcaption { font-size:14px; color:var(--muted); font-weight:700; margin-top:6px; }
.quote { font-size:24px; font-weight:700; line-height:1.35; color:var(--brand); }
.notes p { font-size:17px; line-height:1.5; } ul.good { margin:0; padding-left:22px; font-size:17px; line-height:1.5; } ul.good li::marker { content:"✓  "; color:var(--good); font-weight:900; }
h2 .dot { width:18px; height:18px; border-radius:50%; background:var(--cat-color); display:inline-block; }
h2 .pill { margin-left:auto; font-size:22px; padding:6px 16px; border-radius:99px; background:var(--cat-color); color:#fff; }
.slide[class*="cat-"] { border-top:12px solid var(--cat-color); }
.issues { list-style:none; margin:0; padding:0; display:grid; gap:14px; }
.issues li { display:grid; grid-template-columns:140px 1fr; gap:18px; padding:14px 18px; border-radius:14px; background:var(--soft); }
.issues .sev { align-self:start; text-align:center; font-weight:800; font-size:13px; text-transform:uppercase; letter-spacing:.06em; padding:6px 8px; border-radius:99px; color:#fff; background:var(--sev-nice); }
.sev-critical .sev { background:var(--sev-critical); } .sev-important .sev { background:var(--sev-important); }
.issues .ev { font-size:18px; font-weight:600; line-height:1.35; } .issues .fix { font-size:16px; color:var(--muted); margin-top:4px; }
.issues .fix::before { content:"→ "; color:var(--cat-color); font-weight:900; }
.checklist { list-style:none; margin:16px 0 0; padding:0; display:grid; grid-template-columns:1fr 1fr; gap:14px 40px; }
.checklist li { display:flex; gap:14px; align-items:center; font-size:21px; font-weight:600; padding:14px 18px; border-radius:14px; background:var(--soft); }
.checklist li span { width:34px; height:34px; flex:none; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:900; }
.checklist .yes span { background:var(--good); } .checklist .no span { background:var(--poor); } .checklist .todo span { background:var(--brand); }
.proposal { background:linear-gradient(135deg, var(--soft), #fff 60%); }
.proposal > *:not(.blob) { position:relative; z-index:1; max-width:760px; }
.plan { margin:0; padding-left:28px; font-size:20px; line-height:1.5; } .plan li::marker { color:var(--brand); font-weight:900; }
.proposal .contact { position:absolute; left:80px; bottom:56px; font-size:20px; line-height:1.5; padding:16px 22px; border-radius:16px; background:var(--ink); color:#fff; }
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
<h2>Recommended next step: ${esc(offerTitle)}</h2><p>${esc(offerText)}</p>
${email ? `<h2>Outreach email draft</h2><p><b>Subject:</b> ${esc(email.subject)}</p><p>${esc(email.body).replace(/\n/g, "<br/>")}</p>` : ""}
</body></html>`;
}
