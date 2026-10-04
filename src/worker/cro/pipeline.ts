import type { StepLike } from "../pipeline/lead";
import { getBusiness } from "../db/businesses";
import { latestAudit } from "../db/audits";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import { addCroCost, getCroAudit, replaceCroItems, updateCroAudit } from "../db/cro";
import { selectPages } from "./pages";
import type { CroBrowser } from "./capture";
import type { CroCaller } from "./ai";
import { buildEvidence } from "./evidence";
import { inferBusinessModel, reviewPage, synthesizeRoadmap } from "./stages";
import { applyModeRules, factQuotes, hasTrackingGap, needsRetry, validateRecommendations, validateReview } from "./validate";
import { rankRecommendations } from "./pxl";
import { scenarioFor } from "./scenario";
import { CRO_LIMITS } from "./config";
import type { BusinessModel, CapturedPage, CroFrom, CroPage, CroPageRef, CroStage, Device, PageReview } from "./types";

export interface CroDeps { db: D1Database; raw: R2Bucket; browser?: CroBrowser; ai: CroCaller; now: () => Date }
export interface CroParams { auditId: string; from?: CroFrom }

const ORDER: CroFrom[] = ["capture", "model", "pages", "synthesize"];
const MAX_STRENGTHS = 6;
const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
export const shotKey = (auditId: string, index: number, device: Device, top = false) => `cro/${auditId}/${index}-${device}${top ? "-top" : ""}.jpg`;
export const textKey = (auditId: string, index: number) => `cro/${auditId}/${index}.txt`;

async function b64(raw: R2Bucket, key: string): Promise<string | null> {
  const o = await raw.get(key);
  return o ? Buffer.from(await o.arrayBuffer()).toString("base64") : null;
}
const text = (raw: R2Bucket, key: string) => raw.get(key).then((o) => o?.text() ?? "");

async function loadCaptured(raw: R2Bucket, refs: CroPageRef[]): Promise<CapturedPage[]> {
  return Promise.all(refs.map(async (r) => {
    const o = r.ok && r.key ? await raw.get(r.key) : null;
    return o ? await o.json<CapturedPage>()
      : { ...r, ok: false, desktop: null, mobile: null, axe: null, consoleErrors: [], failedRequests: [], requestHosts: [], flow: null };
  }));
}

async function spend(deps: CroDeps, id: string, stage: CroStage, r: { costUsd: number; model: string | null }) {
  if (!r.costUsd) return;
  await addCroCost(deps.db, id, r.costUsd, stage, r.model);
  await recordUsage(deps.db, "claude_cro", 1, r.costUsd);
}

// One step per page so a slow or broken page is retried on its own and never sinks the audit.
async function capturePage(deps: CroDeps, step: StepLike, auditId: string, index: number, pg: CroPage): Promise<CroPageRef> {
  const failed: CroPageRef = { index, url: pg.url, kind: pg.kind, ok: false, key: null };
  try {
    return await step.do(`capture-${index}`, async () => {
      const c = await deps.browser!(pg.url, { runFlow: index === 0 });
      await recordUsage(deps.db, "browser", 1, PRICES.browserPerRender * 2);
      if (!c.ok || !c.desktop) return failed;
      const ref: CroPageRef = { index, url: c.finalUrl, kind: pg.kind, ok: true, key: `cro/${auditId}/${index}.json` };
      const page: CapturedPage = { ...ref, desktop: c.desktop, mobile: c.mobile, axe: c.axe, consoleErrors: c.consoleErrors,
        failedRequests: c.failedRequests, requestHosts: c.requestHosts, flow: c.flow };
      const jpg = { httpMetadata: { contentType: "image/jpeg" } };
      const puts: Promise<unknown>[] = [
        deps.raw.put(ref.key!, JSON.stringify(page)),
        deps.raw.put(textKey(auditId, index), [c.desktop.text, c.mobile?.text ?? ""].join("\n")),
      ];
      const shots = [[c.desktopJpeg, "desktop", false], [c.mobileJpeg, "mobile", false], [c.desktopTopJpeg, "desktop", true], [c.mobileTopJpeg, "mobile", true]] as const;
      for (const [bytes, device, top] of shots) if (bytes?.length) puts.push(deps.raw.put(shotKey(auditId, index, device, top), bytes, jpg));
      await Promise.all(puts);
      return ref;
    });
  } catch { return failed; }
}

export async function runCroAudit(deps: CroDeps, step: StepLike, p: CroParams) {
  const audit = await getCroAudit(deps.db, p.auditId);
  if (!audit) throw new Error(`CRO audit ${p.auditId} not found`);
  const business = await getBusiness(deps.db, audit.business_id);
  if (!business) throw new Error("Lead not found");
  const id = audit.id;
  const from = ORDER.indexOf(p.from ?? "capture");
  const runs = (s: CroFrom) => ORDER.indexOf(s) >= from;

  // A rebuild or retry restarts the clock the stale-run check measures from.
  await step.do("start", () => updateCroAudit(deps.db, id, { status: "running", error: null, started_at: deps.now().toISOString() }).then(() => true));

  let refs = audit.pages, evidence = audit.evidence;
  if (runs("capture")) {
    if (!business.website_url) throw new Error("This lead has no website to audit");
    if (!deps.browser) throw new Error("Browser Rendering isn't configured, so pages can't be captured");
    await step.do("mark-capture", () => updateCroAudit(deps.db, id, { step: "capture" }).then(() => true));
    const pages = await step.do("pick-pages", async () =>
      selectPages(withScheme(business.website_url!), (await latestAudit(deps.db, business.id))?.site_links ?? {}));
    refs = [];
    for (let i = 0; i < pages.length; i += 2)
      refs.push(...await Promise.all(pages.slice(i, i + 2).map((pg, j) => capturePage(deps, step, id, i + j, pg))));
    if (!refs[0]?.ok) throw new Error("Couldn't load the site");
    evidence = await step.do("evidence", async () => {
      const ev = buildEvidence(await loadCaptured(deps.raw, refs), business);
      await updateCroAudit(deps.db, id, { step: "evidence", pages: refs, partial: refs.some((r) => !r.ok), evidence: ev });
      return ev;
    });
  }
  const okRefs = refs.filter((r) => r.ok);
  if (!okRefs.length) throw new Error("No captured pages to build on; run the full audit first");
  const topShots = async (ref: CroPageRef) => ({ desktop: await b64(deps.raw, shotKey(id, ref.index, "desktop", true)), mobile: await b64(deps.raw, shotKey(id, ref.index, "mobile", true)) });

  let inferred = audit.business_model;
  if (runs("model")) {
    // An unusable answer comes back as null and is thrown below, outside the step, so Workflows doesn't retry (and re-bill) it.
    const found = await step.do("model", async () => {
      await updateCroAudit(deps.db, id, { step: "model" });
      const r = await inferBusinessModel({ business, evidence, shots: await topShots(okRefs[0]) }, deps.ai);
      await spend(deps, id, "model", r);
      if (!r.value) return null;
      await updateCroAudit(deps.db, id, { business_model: r.value });
      return r.value;
    });
    if (!found) throw new Error("Couldn't work out how this business makes money");
    inferred = found;
  }
  if (!inferred) throw new Error("No business model to build on; run the full audit first");
  const model: BusinessModel = { ...inferred, ...audit.model_overrides };

  const ids = new Set(evidence.map((e) => e.id));
  // Quotes are checked against the page text plus phrases a fact quotes (placeholders and labels aren't in the page text); never whole facts.
  const quoted = factQuotes(evidence.map((e) => e.fact));
  const retryReasons = (dropped: { title: string; reason: string }[]) => dropped.map((d) => `"${d.title}": ${d.reason}`);

  let reviews = audit.page_reviews;
  if (runs("pages")) {
    await step.do("mark-pages", () => updateCroAudit(deps.db, id, { step: "pages" }).then(() => true));
    const siteWide = evidence.filter((e) => e.family === "martech" || e.family === "listing");
    const results = await Promise.all(okRefs.map((ref) => step.do(`page-${ref.index}`, async () => {
      const pageEv = [...evidence.filter((e) => e.page === ref.url && e.family !== "martech" && e.family !== "listing"), ...siteWide];
      const input = { business, model, page: ref, evidence: pageEv, shots: await topShots(ref) };
      const texts = [await text(deps.raw, textKey(id, ref.index)), ...quoted];
      const r = await reviewPage(input, deps.ai);
      await spend(deps, id, "pages", r);
      if (!r.value) return null;
      let v = validateReview(r.value, ids, texts);
      if (needsRetry(r.value.issues.length, v.dropped.length)) {
        const again = await reviewPage(input, deps.ai, retryReasons(v.dropped));
        await spend(deps, id, "pages", again);
        if (again.value) v = validateReview(again.value, ids, texts);
      }
      return v.review;
    })));
    reviews = results.filter((r): r is PageReview => !!r);
    await step.do("save-pages", () => updateCroAudit(deps.db, id, { page_reviews: reviews, reviewed_as: model.model }).then(() => true));
  }

  const written = await step.do("synthesize", async () => {
    await updateCroAudit(deps.db, id, { step: "synthesize" });
    const texts = [...await Promise.all(okRefs.map((r) => text(deps.raw, textKey(id, r.index)))), ...quoted];
    const input = { business, model, reviews, evidence };
    const r = await synthesizeRoadmap(input, deps.ai);
    await spend(deps, id, "synthesize", r);
    if (!r.value) return null;
    let out = r.value;
    let v = validateRecommendations(out.recommendations, ids, texts);
    // The drop share is measured against what the model returned, before any cap.
    if (needsRetry(out.recommendations.length, v.dropped.length)) {
      const again = await synthesizeRoadmap(input, deps.ai, retryReasons(v.dropped));
      await spend(deps, id, "synthesize", again);
      if (again.value) { out = again.value; v = validateRecommendations(out.recommendations, ids, texts); }
    }
    const ranked = rankRecommendations(applyModeRules(v.kept, model.traffic_tier), evidence, model.model, { trackingGap: hasTrackingGap(evidence) });
    await replaceCroItems(deps.db, id, ranked);
    const n = ranked.length;
    await updateCroAudit(deps.db, id, {
      strengths: out.strengths.slice(0, MAX_STRENGTHS), positioning: out.positioning, tracking_plan: out.tracking_plan,
      scenario_inputs: scenarioFor(audit.scenario_inputs, model),
      // Never pad with generic advice: say so plainly instead.
      warning: n < CRO_LIMITS.minItems
        ? `Only ${n} recommendation${n === 1 ? "" : "s"} had solid evidence behind ${n === 1 ? "it" : "them"}. The site may be hard to read automatically; check it by hand before presenting.`
        : null,
      status: "done", step: "done", error: null, completed_at: deps.now().toISOString(),
    });
    return n;
  });
  if (written === null) throw new Error("Couldn't write the roadmap");
}

export async function runCroWithErrorHandling(deps: CroDeps, step: StepLike, p: CroParams) {
  try {
    await runCroAudit(deps, step, p);
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    await step.do("record-error", () => updateCroAudit(deps.db, p.auditId, { status: "failed", error: message }).then(() => true));
  }
}
