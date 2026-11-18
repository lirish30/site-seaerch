import type { StepLike } from "../pipeline/lead";
import { getBusiness } from "../db/businesses";
import { latestAudit } from "../db/audits";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import { failCroAudit, getCroAudit, updateCroAudit } from "../db/cro";
import { selectPages } from "./pages";
import type { CroBrowser } from "./capture";
import { buildEvidence } from "./evidence";
import { shotKey, textKey } from "./keys";
import type { CapturedPage, CroFrom, CroPage, CroPageRef } from "./types";

// Where the stored screenshots and page text live (the routes and the queue read them by these keys), and how the Claude stages are started.
export { shotKey, textKey } from "./keys";
export { startCroStages } from "../queue/cro";

/** `start` hands the audit over to the Claude stages once the pages are captured and the evidence is built: it queues them and returns, never waiting for Claude. */
export interface CroDeps { db: D1Database; raw: R2Bucket; browser?: CroBrowser; now: () => Date; start: (auditId: string, from: "model" | "pages" | "synthesize") => Promise<void> }
export interface CroParams { auditId: string; from?: CroFrom }

const ORDER: CroFrom[] = ["capture", "model", "pages", "synthesize"];
const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

async function loadCaptured(raw: R2Bucket, refs: CroPageRef[]): Promise<CapturedPage[]> {
  return Promise.all(refs.map(async (r) => {
    const o = r.ok && r.key ? await raw.get(r.key) : null;
    return o ? await o.json<CapturedPage>()
      : { ...r, ok: false, desktop: null, mobile: null, axe: null, consoleErrors: [], failedRequests: [], requestHosts: [], flow: null };
  }));
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

/**
 * The workflow's part of an audit: capture the pages and build the evidence ledger, then hand over to the Claude stages (the business model, a review
 * per page, the roadmap), which run on the Claude queue. The workflow ends there: the audit is `waiting` and nothing blocks on Claude.
 */
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

  let refs = audit.pages;
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
    await step.do("evidence", async () => {
      const ev = buildEvidence(await loadCaptured(deps.raw, refs), business);
      await updateCroAudit(deps.db, id, { step: "evidence", pages: refs, partial: refs.some((r) => !r.ok), evidence: ev });
      return true;
    });
  }
  if (!refs.some((r) => r.ok)) throw new Error("No captured pages to build on; run the full audit first");
  if (from > ORDER.indexOf("model") && !audit.business_model) throw new Error("No business model to build on; run the full audit first");

  // The last step: queue the first Claude stage this run needs and let the workflow end. The audit is `waiting` from here.
  const first = runs("model") ? "model" : runs("pages") ? "pages" : "synthesize";
  await step.do("start-stages", () => deps.start(id, first).then(() => true));
}

export async function runCroWithErrorHandling(deps: CroDeps, step: StepLike, p: CroParams) {
  try {
    await runCroAudit(deps, step, p);
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    await step.do("record-error", () => failCroAudit(deps.db, p.auditId, message).then(() => true));
  }
}
