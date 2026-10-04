import type { Env } from "../env";
import { esc } from "./esc";
import { latestCroAudit, listCroItems } from "../db/cro";
import { shotKey } from "../cro/pipeline";
import { BIZ_MODELS } from "../cro/models";
import { scenarioRange, SCENARIO_LABEL } from "../cro/scenario";
import { cropView, itemCrop } from "../cro/crop";
import { CRO_LIMITS } from "../cro/config";
import type { BusinessModel, Crop, CroAudit, CroItem, Device, Horizon, RecMode } from "../cro/types";

/** shots: full-page screenshots needed by the top items, keyed "<pageIndex>-<device>", base64. */
export interface CroReportData { audit: CroAudit; items: CroItem[]; shots: Record<string, string> }

const MODE: Record<RecMode, string> = { fix: "Just fix", fix_measure: "Fix & measure", test: "Test", strategic: "Strategic project" };
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const effective = (a: CroAudit): BusinessModel | null => (a.business_model ? { ...a.business_model, ...a.model_overrides } : null);

/** "Do this month" slides take the first few 30-day items; everything else goes on the 90-day roadmap slide. */
function splitItems(items: CroItem[]): { top: CroItem[]; rest: CroItem[] } {
  const top = items.filter((i) => i.horizon === 30).slice(0, CRO_LIMITS.topItems);
  return { top, rest: items.filter((i) => !top.includes(i)) };
}

export async function croReportFor(env: Pick<Env, "DB" | "RAW">, businessId: string): Promise<CroReportData | null> {
  const audit = await latestCroAudit(env.DB, businessId, { status: "done" });
  if (!audit) return null;
  const items = (await listCroItems(env.DB, audit.id)).filter((i) => i.included);
  const needed = new Set(splitItems(items).top.map((i) => itemCrop(i, audit.evidence)).filter((c): c is Crop => !!c).map((c) => `${c.pageIndex}-${c.device}`));
  const shots: Record<string, string> = {};
  for (const k of needed) {
    const [page, device] = k.split("-");
    const o = await env.RAW.get(shotKey(audit.id, Number(page), device as Device));
    if (o) shots[k] = Buffer.from(await o.arrayBuffer()).toString("base64");
  }
  return { audit, items, shots };
}

function cropHtml(c: Crop | null, d: CroReportData, n: number): string {
  if (!c || !d.shots[`${c.pageIndex}-${c.device}`]) return "";
  const v = cropView(c, 520);
  return `<div class="cro-crop cro-shot-${c.pageIndex}-${c.device}" style="width:${v.width}px;height:${v.height}px;background-size:${v.bgWidth}px auto;background-position:${v.bgX}px ${v.bgY}px"><span class="cro-pin" style="left:${v.markerX}px;top:${v.markerY}px">${n}</span></div>`;
}

export function renderCroSlides(d: CroReportData): string[] {
  const a = d.audit, m = effective(a);
  const { top, rest } = splitItems(d.items);
  const slides: string[] = [];
  if (m) slides.push(`<section class="slide cro">
    <p class="eyebrow">Conversion roadmap</p>
    <h2>How your website makes money</h2>
    <div class="cro-grid">
      <div><h3>What we believe your business is</h3><p class="cro-big">${esc(BIZ_MODELS[m.model].label)}</p>
        <p>Main goal: <strong>${esc(m.primary_conversion)}</strong></p>
        <p class="muted">Typical job value ${money(m.deal_value_band.low)}–${money(m.deal_value_band.high)} · ${esc(m.sales_cycle.label)}</p></div>
      ${a.positioning ? `<div><h3>Your site says</h3><p class="cro-quote">“${esc(a.positioning.says_now)}”</p><h3>It should say</h3><p class="cro-quote good">“${esc(a.positioning.should_say)}”</p></div>` : ""}
    </div>
    <p class="muted small">These are our assumptions. If any are off, tell us and we'll adjust the plan.</p>
  </section>`);
  if (a.strengths.length) slides.push(`<section class="slide cro"><h2>What's already working</h2><ul class="cro-list">${a.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></section>`);
  top.forEach((it, i) => slides.push(`<section class="slide cro cro-item">
    <p class="eyebrow">Do this month · ${i + 1} of ${top.length}</p>
    <h2>${esc(it.title)} <span class="pill">${MODE[it.mode]}</span></h2>
    <div class="cro-item-grid">
      <div><h3>What we saw</h3><p>${esc(it.observation)}</p><h3>The change</h3><p>${esc(it.change)}</p><h3>Why it matters</h3><p>${esc(it.why)}</p>
        ${it.we_can_do_it ? `<p class="cro-wcd">${esc(it.we_can_do_it)}</p>` : ""}</div>
      ${cropHtml(itemCrop(it, a.evidence), d, i + 1)}
    </div>
  </section>`));
  if (rest.length) {
    const col = (h: Horizon, label: string) => `<div><h3>${label}</h3><ol>${rest.filter((r) => r.horizon === h).map((r) => `<li>${esc(r.title)}</li>`).join("") || `<li class="muted">Nothing here yet</li>`}</ol></div>`;
    slides.push(`<section class="slide cro"><h2>Your 90-day roadmap</h2><div class="cro-cols">${col(30, "Also this month")}${col(60, "Days 31–60")}${col(90, "Days 61–90")}</div></section>`);
  }
  if (a.tracking_plan.length) slides.push(`<section class="slide cro"><h2>What to measure</h2>
    <p class="blurb">So every change is proven with real calls, forms and bookings.</p>
    <table class="cro-table">${a.tracking_plan.map((t) => `<tr><td><strong>${esc(t.event)}</strong></td><td>${esc(t.why)}</td></tr>`).join("")}</table></section>`);
  if (a.scenario_inputs) {
    const s = a.scenario_inputs, r = scenarioRange(s);
    slides.push(`<section class="slide cro"><h2>What it could be worth</h2>
      <p class="cro-big">${r.leads[0]}–${r.leads[1]} more leads a month · ${money(r.revenue[0])}–${money(r.revenue[1])} in new business</p>
      <ul class="cro-list"><li>${s.visitors.toLocaleString("en-US")} visitors a month</li><li>Turning ${pct(s.currentRate)} of visitors into leads today, ${pct(s.targetRate)} after the changes</li>
        <li>${pct(s.closeRate)} of leads become customers</li><li>${money(s.dealValue)} average job</li></ul>
      <p class="muted">${SCENARIO_LABEL}. Not a guarantee.</p></section>`);
  }
  const offers = d.items.map((i) => i.we_can_do_it).filter(Boolean);
  if (offers.length) slides.push(`<section class="slide cro"><h2>We can do this for you</h2><ul class="cro-list">${offers.slice(0, 10).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`);
  return slides;
}

export function croCss(d: CroReportData): string {
  return CRO_CSS + Object.entries(d.shots).map(([k, b]) => `.cro-shot-${k}{background-image:url(data:image/jpeg;base64,${b})}`).join("\n");
}

export function croDocSection(d: CroReportData): string {
  const m = effective(d.audit);
  return `<h2>Conversion roadmap</h2>${m ? `<p>${esc(BIZ_MODELS[m.model].label)}. Main goal: ${esc(m.primary_conversion)}.</p>` : ""}
<ol>${d.items.map((i) => `<li><b>${esc(i.title)}</b> (${MODE[i.mode]}, ${i.horizon} days)<br/>${esc(i.observation)}<br/><i>Change: ${esc(i.change)}</i></li>`).join("")}</ol>
${d.audit.tracking_plan.length ? `<h3>What to measure</h3><ul>${d.audit.tracking_plan.map((t) => `<li>${esc(t.event)}: ${esc(t.why)}</li>`).join("")}</ul>` : ""}`;
}

const CRO_CSS = `
.cro h3 { color:var(--brand); }
.cro-grid { display:grid; grid-template-columns:1fr 1fr; gap:48px; margin-top:24px; }
.cro-big { font-size:30px; font-weight:800; margin:6px 0 10px; }
.cro-quote { font-size:22px; line-height:1.4; } .cro-quote.good { color:var(--good); font-weight:700; }
.cro-list { font-size:22px; line-height:1.6; }
.cro-item-grid { display:grid; grid-template-columns:1fr 520px; gap:40px; align-items:start; font-size:19px; line-height:1.45; }
.cro-item h3 { margin:14px 0 4px; font-size:16px; text-transform:uppercase; letter-spacing:.08em; }
.cro-wcd { margin-top:18px; padding:12px 16px; background:var(--soft); border-radius:12px; font-weight:700; }
.cro-crop { position:relative; border-radius:14px; border:1px solid var(--line); background-repeat:no-repeat; box-shadow:0 10px 30px rgba(22,19,43,.12); }
.cro-pin { position:absolute; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%; background:var(--brand2); color:#fff; font-weight:800; display:grid; place-items:center; box-shadow:0 0 0 4px rgba(255,92,168,.3); }
.cro-cols { display:grid; grid-template-columns:repeat(3,1fr); gap:32px; font-size:19px; line-height:1.5; }
.cro-table { border-collapse:collapse; font-size:19px; } .cro-table td { padding:10px 18px 10px 0; border-bottom:1px solid var(--line); vertical-align:top; }
.small { font-size:15px; }
`;
