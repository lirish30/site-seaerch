import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { isSocialOnlyUrl } from "../crawler/extract";
import { checkSpend, PRICES } from "../cost";
import { logActivity } from "../db/activity";
import { createCroAudit, failCroAudit, getCroAudit, latestCroAudit, listCroAudits, listCroItems, runningCroAudit, updateCroAudit, updateCroItem, type CroItemPatch } from "../db/cro";
import { shotKey, textKey } from "../cro/pipeline";
import { scenarioFor } from "../cro/scenario";
import { BIZ_MODEL_KEYS, type BusinessModel, type CroAudit, type CroFrom, type CroStep } from "../cro/types";

export const croRoutes = new Hono<{ Bindings: Env }>();

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
/** The site to audit, or null when the lead has none, it isn't a parseable address, or it's only a social profile. */
function auditableSite(websiteUrl: string | null | undefined): string | null {
  const site = websiteUrl?.trim();
  if (!site) return null;
  try { new URL(withScheme(site)); } catch { return null; }
  return isSocialOnlyUrl(withScheme(site)) ? null : site;
}

const start = (env: Env, auditId: string, from?: CroFrom) =>
  env.CRO_AUDIT_WORKFLOW.create({ id: `cro-${auditId}-${Date.now()}`, params: from ? { auditId, from } : { auditId } });
type Ctx = Context<{ Bindings: Env }>;

/** Starts the workflow. If that fails the audit is failed straight away, so the lead isn't blocked until the stale-run timeout. */
async function launch(c: Ctx, auditId: string, from?: CroFrom) {
  try { await start(c.env, auditId, from); return null; } catch {
    await failCroAudit(c.env.DB, auditId, "Couldn't start the audit workflow");
    return c.json({ error: "Couldn't start the audit workflow" }, 502);
  }
}

/** Flips a not-running audit to running in a single statement, so two simultaneous requests can't both start it. */
async function claim(db: D1Database, auditId: string, from: CroFrom): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE cro_audits SET status = 'running', error = NULL, step = ?, started_at = ? WHERE id = ? AND status <> 'running'`,
  ).bind(from, new Date().toISOString(), auditId).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** A 409 response when this audit, or another audit of the same lead, is in flight. A dead run is failed first. */
async function busy(c: Ctx, a: CroAudit) {
  const running = await runningCroAudit(c.env.DB, a.business_id, new Date());
  if (!running) return null;
  return c.json({ error: running.id === a.id ? "This audit is still running" : "A CRO audit is already running for this lead" }, 409);
}

const b64 = async (raw: R2Bucket, key: string) => {
  const o = await raw.get(key);
  return o ? Buffer.from(await o.arrayBuffer()).toString("base64") : null;
};

croRoutes.post("/leads/:id/cro-audit", async (c) => {
  const id = c.req.param("id");
  const b = await getBusiness(c.env.DB, id);
  if (!b) return c.json({ error: "not found" }, 404);
  if (!auditableSite(b.website_url)) return c.json({ error: "This lead has no website to audit" }, 400);
  if (await runningCroAudit(c.env.DB, id, new Date())) return c.json({ error: "A CRO audit is already running for this lead" }, 409);
  const spend = await checkSpend(c.env.DB, PRICES.croAudit);
  if (!spend.ok) return c.json({ error: "spend limit", ...spend }, 402);
  const a = await createCroAudit(c.env.DB, id);
  const failed = await launch(c, a.id);
  if (failed) return failed;
  await logActivity(c.env.DB, id, "cro_audit", null);
  return c.json(a, 202);
});

croRoutes.get("/leads/:id/cro-audit", async (c) => {
  const id = c.req.param("id"), which = c.req.query("audit");
  await runningCroAudit(c.env.DB, id, new Date()); // fails a dead run so the UI stops polling it
  const a = which ? await getCroAudit(c.env.DB, which) : await latestCroAudit(c.env.DB, id);
  if (!a || a.business_id !== id) return c.json({ audit: null, items: [] });
  return c.json({ audit: a, items: await listCroItems(c.env.DB, a.id) });
});

croRoutes.get("/leads/:id/cro-audits", async (c) => c.json(await listCroAudits(c.env.DB, c.req.param("id"))));

// The only item fields a request can change; the patch is built from this list, never from the body itself.
const ITEM_FIELDS = ["title", "observation", "change", "why", "we_can_do_it", "included", "rank", "horizon"] as const;
const ItemPatch = z.object({
  title: z.string().trim().min(1).max(200), observation: z.string().max(2000), change: z.string().max(2000), why: z.string().max(2000),
  we_can_do_it: z.string().max(500), included: z.boolean(), rank: z.number().int().min(1).max(200),
  horizon: z.union([z.literal(30), z.literal(60), z.literal(90)]),
}).partial();
croRoutes.patch("/cro-items/:id", async (c) => {
  const p = ItemPatch.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const patch: Record<string, unknown> = {};
  for (const k of ITEM_FIELDS) if (p.data[k] !== undefined) patch[k] = p.data[k];
  if (!Object.keys(patch).length) return c.json({ error: "invalid" }, 400);
  const item = await updateCroItem(c.env.DB, c.req.param("id"), patch as CroItemPatch);
  return item ? c.json(item) : c.json({ error: "not found" }, 404);
});

const MAX_AMOUNT = 1e9;
const amount = z.number().min(0).max(MAX_AMOUNT);
const rate = z.number().min(0).max(1);
const Assumptions = z.object({
  overrides: z.object({
    model: z.enum(BIZ_MODEL_KEYS), primary_conversion: z.string().trim().min(1).max(200), traffic_tier: z.enum(["low", "medium", "high"]),
    deal_value_band: z.object({ low: amount, high: amount }).refine((v) => v.low <= v.high, "low must not exceed high"),
    sales_cycle: z.string().trim().min(1).max(100),
  }).partial().optional(),
  scenario: z.object({ visitors: amount, currentRate: rate, targetRate: rate, closeRate: rate, dealValue: amount }).optional(),
});
croRoutes.patch("/cro-audits/:id/assumptions", async (c) => {
  const a = await getCroAudit(c.env.DB, c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const p = Assumptions.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  // A running pipeline holds its own copy of these and would overwrite the edit.
  if (a.status === "running") return c.json({ error: "This audit is still running" }, 409);
  const o = p.data.overrides ?? {};
  const overrides: Partial<BusinessModel> = { ...a.model_overrides };
  if (o.model) overrides.model = o.model;
  if (o.primary_conversion) overrides.primary_conversion = o.primary_conversion;
  if (o.traffic_tier) overrides.traffic_tier = o.traffic_tier;
  if (o.deal_value_band) overrides.deal_value_band = { low: o.deal_value_band.low, high: o.deal_value_band.high, rationale: "Set by you", evidence_ids: [] };
  if (o.sales_cycle) overrides.sales_cycle = { label: o.sales_cycle, rationale: "Set by you" };
  const s = p.data.scenario;
  // Unless the user saved their own scenario, job value, traffic and model edits carry through to it straight away.
  const moves = !!(o.model || o.traffic_tier || o.deal_value_band);
  const followed = !s && moves && a.scenario_inputs && a.business_model ? scenarioFor(a.scenario_inputs, { ...a.business_model, ...overrides }) : null;
  await updateCroAudit(c.env.DB, a.id, {
    model_overrides: overrides,
    ...(s ? { scenario_inputs: { visitors: s.visitors, currentRate: s.currentRate, targetRate: s.targetRate, closeRate: s.closeRate, dealValue: s.dealValue, edited: true } }
      : followed ? { scenario_inputs: followed } : {}),
  });
  return c.json(await getCroAudit(c.env.DB, a.id));
});

const effectiveModel = (a: CroAudit) => a.model_overrides.model ?? a.business_model?.model ?? null;

croRoutes.post("/cro-audits/:id/rebuild", async (c) => {
  const a = await getCroAudit(c.env.DB, c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const inFlight = await busy(c, a);
  if (inFlight) return inFlight;
  if (!a.business_model || !a.pages.some((p) => p.ok)) return c.json({ error: "Nothing to rebuild yet; run the audit first" }, 409);
  const spend = await checkSpend(c.env.DB, PRICES.croAudit / 2);
  if (!spend.ok) return c.json({ error: "spend limit", ...spend }, 402);
  // Page reviews are written for a specific business model, so a changed model re-runs them.
  const from: CroFrom = effectiveModel(a) !== a.reviewed_as ? "pages" : "synthesize";
  if (!(await claim(c.env.DB, a.id, from))) return c.json({ error: "This audit is still running" }, 409);
  const failed = await launch(c, a.id, from);
  return failed ?? c.json({ ok: true, from }, 202);
});

const ORDER: CroFrom[] = ["capture", "model", "pages", "synthesize"];
const STEP_FROM: Record<CroStep, CroFrom> = { capture: "capture", evidence: "capture", model: "model", pages: "pages", synthesize: "synthesize", done: "synthesize" };
/** Where a failed audit resumes. `step` can be stale (the pipeline doesn't reset it on a restart), so the stored outputs set the
 *  furthest point it may resume from; `step` is only used when it points earlier, i.e. the failure was in a stage whose old output is still there. */
function resumePoint(a: CroAudit): CroFrom {
  const stored: CroFrom = !(a.pages.some((p) => p.ok) && a.evidence.length) ? "capture"
    : !a.business_model ? "model"
    : !a.page_reviews.length ? "pages"
    : "synthesize";
  const step = STEP_FROM[a.step] ?? "synthesize";
  const from = ORDER.indexOf(step) < ORDER.indexOf(stored) ? step : stored;
  // Reviews were written for a different business model than the one now in force.
  return from === "synthesize" && effectiveModel(a) !== a.reviewed_as ? "pages" : from;
}

croRoutes.post("/cro-audits/:id/retry", async (c) => {
  const a = await getCroAudit(c.env.DB, c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  if (a.status !== "failed") return c.json({ error: "Only a failed audit can be retried" }, 409);
  const inFlight = await busy(c, a);
  if (inFlight) return inFlight;
  const from = resumePoint(a);
  const spend = await checkSpend(c.env.DB, from === "synthesize" ? PRICES.croAudit / 2 : PRICES.croAudit);
  if (!spend.ok) return c.json({ error: "spend limit", ...spend }, 402);
  if (!(await claim(c.env.DB, a.id, from))) return c.json({ error: "This audit is still running" }, 409);
  const failed = await launch(c, a.id, from);
  return failed ?? c.json({ ok: true, from }, 202);
});

croRoutes.get("/cro-audits/:id/shot/:page/:device", async (c) => {
  const page = c.req.param("page"), device = c.req.param("device");
  // Strict checks here (Hono's inline regexes aren't anchored); the R2 key is rebuilt from the stored audit id and a page index
  // that audit actually has, so nothing from the URL is ever concatenated into it.
  if (!/^[0-9]{1,6}$/.test(page) || (device !== "desktop" && device !== "mobile")) return c.json({ error: "not found" }, 404);
  const a = await getCroAudit(c.env.DB, c.req.param("id"));
  const index = Number(page);
  if (!a || !a.pages.some((p) => p.index === index)) return c.json({ error: "not found" }, 404);
  const o = await c.env.RAW.get(shotKey(a.id, index, device, c.req.query("top") === "1"));
  if (!o) return c.json({ error: "not found" }, 404);
  return new Response(o.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
});

croRoutes.get("/cro-audits/:id/eval-fixture", async (c) => {
  const a = await getCroAudit(c.env.DB, c.req.param("id"));
  if (!a || a.status !== "done") return c.json({ error: "not found" }, 404);
  const business = await getBusiness(c.env.DB, a.business_id);
  const pages = await Promise.all(a.pages.filter((p) => p.ok).map(async (ref) => ({
    ref, text: await c.env.RAW.get(textKey(a.id, ref.index)).then((o) => o?.text() ?? ""),
    shots: { desktop: await b64(c.env.RAW, shotKey(a.id, ref.index, "desktop", true)), mobile: await b64(c.env.RAW, shotKey(a.id, ref.index, "mobile", true)) },
  })));
  return c.json({ business, evidence: a.evidence, pages }, 200, { "content-disposition": `attachment; filename="cro-fixture-${a.id}.json"` });
});
