// Haiku vs Sonnet eval gate for the CRO audit (spec §6). Run: ANTHROPIC_API_KEY=... npm run cro-eval
// Spends real money (~$2-3 for six sites). Fixtures hold prospect data and stay git-ignored.
import { anthropicCroCaller, type CroCaller } from "../src/worker/cro/ai";
import { inferBusinessModel, reviewPage, synthesizeRoadmap } from "../src/worker/cro/stages";
import { validateRecommendations, validateReview } from "../src/worker/cro/validate";
import type { CroModelId } from "../src/worker/cro/config";
import type { Business } from "../src/worker/types";
import type { BusinessModel, CroPageRef, Evidence, PageReview, Recommendation } from "../src/worker/cro/types";

/** The JSON from GET /api/cro-audits/:id/eval-fixture. The business row carries more columns; only the stage inputs and the name are read. */
export interface Fixture { business: Business; evidence: Evidence[]; pages: { ref: CroPageRef; text: string; shots: { desktop: string | null; mobile: string | null } }[] }
export interface NamedFixture { name: string; fx: Fixture }
type Stage = "model" | "pages" | "synthesize";
export interface M { calls: number; schemaFails: number; errors: number; items: number; dropped: number; quoted: number; costUsd: number }
type SiteOut = { model: BusinessModel | null; recs: Recommendation[] };

export const MODELS: [CroModelId, CroModelId] = ["claude-haiku-4-5", "claude-sonnet-5-5"];
const STAGES: Stage[] = ["model", "pages", "synthesize"];
const GATE_POINTS = 10;
const QUOTED = /["“][^"”]{4,}["”]/;

const blank = (): M => ({ calls: 0, schemaFails: 0, errors: 0, items: 0, dropped: 0, quoted: 0, costUsd: 0 });
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const failPct = (m: M) => pct(m.schemaFails + m.errors, m.calls);

/** Small seeded PRNG (mulberry32) so the A/B order is reproducible from the seed recorded in the key file. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escapes model- and site-authored text for HTML text and attribute contexts. */
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function parseFixture(raw: unknown, name: string): Fixture {
  const f = raw as Partial<Fixture> | null;
  if (!f || typeof f !== "object" || !f.business || !Array.isArray(f.evidence) || !Array.isArray(f.pages))
    throw new Error(`${name} is not an eval fixture (expected business, evidence[] and pages[])`);
  return f as Fixture;
}

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export interface EvalResult {
  md: string; html: string;
  key: { seed: number; sites: Record<string, { A: CroModelId; B: CroModelId }> };
  metrics: Record<CroModelId, Record<Stage, M>>;
  verdicts: Record<Stage, boolean>;
  failures: string[];
}
export interface EvalOpts { seed: number; date: string; log?: (line: string) => void }

export async function runEval(fixtures: NamedFixture[], makeCaller: (m: CroModelId) => CroCaller, o: EvalOpts): Promise<EvalResult> {
  const log = o.log ?? (() => {});
  const metrics = Object.fromEntries(MODELS.map((m) => [m, { model: blank(), pages: blank(), synthesize: blank() }])) as Record<CroModelId, Record<Stage, M>>;
  const out: Record<string, Partial<Record<CroModelId, SiteOut>>> = {};
  const failures: string[] = [];

  for (const { name, fx } of fixtures) {
    const ids = new Set(fx.evidence.map((e) => e.id));
    const facts = fx.evidence.map((e) => e.fact);
    const siteWide = fx.evidence.filter((e) => e.family === "martech" || e.family === "listing");
    out[name] = {};
    for (const m of MODELS) {
      log(`${name} · ${m}`);
      const call = makeCaller(m);
      const S = metrics[m];
      // A refusal or API error throws; it is a failure for that stage on that site, never the end of the run.
      const fail = (st: Stage, what: string, e: unknown) => { S[st].errors++; failures.push(`${m} · ${name} · ${what}: ${errMsg(e)}`); };

      let bm: BusinessModel | null = null;
      S.model.calls++;
      try {
        const r = await inferBusinessModel({ business: fx.business, evidence: fx.evidence, shots: fx.pages[0]?.shots ?? { desktop: null, mobile: null } }, call);
        S.model.costUsd += r.costUsd;
        if (r.value) bm = r.value; else S.model.schemaFails++;
      } catch (e) { fail("model", "business model", e); }
      if (!bm) { out[name][m] = { model: null, recs: [] }; continue; }

      const reviews: PageReview[] = [];
      for (const p of fx.pages) {
        // Mirrors the pipeline: this page's own evidence plus the site-wide martech and listing rows.
        const pageEv = [...fx.evidence.filter((e) => e.page === p.ref.url && e.family !== "martech" && e.family !== "listing"), ...siteWide];
        S.pages.calls++;
        try {
          const r = await reviewPage({ business: fx.business, model: bm, page: p.ref, evidence: pageEv, shots: p.shots }, call);
          S.pages.costUsd += r.costUsd;
          if (!r.value) { S.pages.schemaFails++; continue; }
          const v = validateReview(r.value, ids, [p.text, ...facts]);
          S.pages.items += r.value.issues.length; S.pages.dropped += v.dropped.length; S.pages.quoted += r.value.issues.filter((i) => i.quote).length;
          reviews.push(v.review);
        } catch (e) { fail("pages", p.ref.url, e); }
      }

      S.synthesize.calls++;
      try {
        const s = await synthesizeRoadmap({ business: fx.business, model: bm, reviews, evidence: fx.evidence }, call);
        S.synthesize.costUsd += s.costUsd;
        if (!s.value) { S.synthesize.schemaFails++; out[name][m] = { model: bm, recs: [] }; continue; }
        // Like production: the drop share is measured against what the model returned, before any cap.
        const v = validateRecommendations(s.value.recommendations, ids, [...fx.pages.map((p) => p.text), ...facts]);
        S.synthesize.items += s.value.recommendations.length; S.synthesize.dropped += v.dropped.length;
        S.synthesize.quoted += s.value.recommendations.filter((r) => QUOTED.test(r.observation)).length;
        out[name][m] = { model: bm, recs: v.kept };
      } catch (e) { fail("synthesize", "roadmap", e); out[name][m] = { model: bm, recs: [] }; }
    }
  }

  const [H, S] = MODELS;
  const both = fixtures.filter(({ name }) => out[name][H]?.model && out[name][S]?.model);
  const agree = both.filter(({ name }) => out[name][H]!.model!.model === out[name][S]!.model!.model).length;
  // Spec §6: Haiku loses a stage if it is more than 10 points worse on drop rate or quote rate. Failure rate is gated the same way
  // (it is the only signal for the model stage, which has no validator).
  const worse = (st: Stage) => {
    const h = metrics[H][st], s = metrics[S][st];
    return pct(h.dropped, h.items) - pct(s.dropped, s.items) > GATE_POINTS
      || pct(s.quoted, s.items) - pct(h.quoted, h.items) > GATE_POINTS
      || failPct(h) - failPct(s) > GATE_POINTS;
  };
  const verdicts = { model: worse("model"), pages: worse("pages"), synthesize: worse("synthesize") };
  const verdictLine = (st: Stage) => `- **${st}**: ${verdicts[st]
    ? `Haiku is more than ${GATE_POINTS} points worse → set CRO_MODELS.${st} = "claude-sonnet-5-5"`
    : "Haiku holds up on the numbers → keep claude-haiku-4-5"}`;

  const needed = Math.ceil((fixtures.length * 4) / 6);
  const md = [`# CRO eval · ${o.date} · ${fixtures.length} sites`, "",
    "| Model | Stage | Calls | Schema fails | API errors | Dropped by validator | With verbatim quote | Cost |", "|---|---|---|---|---|---|---|---|",
    ...MODELS.flatMap((m) => STAGES.map((st) => {
      const x = metrics[m][st];
      return `| ${m} | ${st} | ${x.calls} | ${pct(x.schemaFails, x.calls)}% | ${x.errors} | ${st === "model" ? "–" : `${pct(x.dropped, x.items)}%`} | ${st === "model" ? "–" : `${pct(x.quoted, x.items)}%`} | $${x.costUsd.toFixed(3)} |`;
    })),
    "", `Business-model agreement: ${agree}/${both.length} sites where both models answered (${fixtures.length} sites total)`,
    "", "## Verdict on the numbers", verdictLine("model"), verdictLine("pages"), verdictLine("synthesize"), "",
    ...(failures.length ? ["## Errors (refusals and API failures)", ...failures.map((f) => `- ${f}`), ""] : []),
    "## Blind read", "Open scripts/out/cro-eval.html and pick the better roadmap (A or B) for each site, without opening the key.",
    `Then check your picks against scripts/out/cro-eval-key.json. If Sonnet wins on at least ${needed} of ${fixtures.length} sites, set CRO_MODELS.synthesize = "claude-sonnet-5-5" even if the numbers above say keep Haiku.`,
  ].join("\n");

  // Randomise which model is A per site; the seed goes in the key so the assignment can be reproduced.
  const rnd = seededRandom(o.seed);
  const sites: EvalResult["key"]["sites"] = {};
  const col = (r?: SiteOut) => (r?.recs ?? []).slice(0, 10)
    .map((x, i) => `<li><b>${i + 1}. ${esc(x.title)}</b><br>${esc(x.observation)}<br><i>${esc(x.change)}</i></li>`).join("");
  const sections = fixtures.map(({ name, fx }, n) => {
    sites[name] = rnd() < 0.5 ? { A: S, B: H } : { A: H, B: S };
    return `<section><h2>Site ${n + 1}: ${esc(fx.business?.name ?? "")}</h2><div class="g"><div><h3>A</h3><ol>${col(out[name][sites[name].A])}</ol></div><div><h3>B</h3><ol>${col(out[name][sites[name].B])}</ol></div></div></section>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>CRO blind read</title><style>body{font:14px system-ui;margin:24px}section{margin-bottom:40px}.g{display:grid;grid-template-columns:1fr 1fr;gap:24px}li{margin-bottom:10px}</style>\n${sections.join("")}`;

  return { md, html, key: { seed: o.seed, sites }, metrics, verdicts, failures };
}

async function cli() {
  const { readFileSync, readdirSync, writeFileSync, mkdirSync } = await import("node:fs");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }
  const DIR = "scripts/cro-eval/fixtures";
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) { console.error(`Add fixtures to ${DIR}: open /api/cro-audits/<id>/eval-fixture while logged in and save the JSON.`); process.exit(1); }
  const fixtures = files.map((f) => ({ name: f, fx: parseFixture(JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")), f) }));
  const seed = process.env.CRO_EVAL_SEED ? Number(process.env.CRO_EVAL_SEED) >>> 0 : Math.floor(Math.random() * 2 ** 32);

  const r = await runEval(fixtures, (m) => anthropicCroCaller(apiKey, { model: m, pages: m, synthesize: m }),
    { seed, date: new Date().toISOString().slice(0, 10), log: (l) => console.log(l) });

  mkdirSync("scripts/out", { recursive: true });
  writeFileSync("scripts/out/cro-eval.md", r.md);
  writeFileSync("scripts/out/cro-eval.html", r.html);
  writeFileSync("scripts/out/cro-eval-key.json", JSON.stringify(r.key, null, 2));
  console.log(r.md);
}

// Only when run directly (npm run cro-eval), never when imported by a test.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("cro-eval.ts")) await cli();
