import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { beginPageReviews, failCroAudit, finishPageReviews, finishRoadmap, getCroAudit, replaceCroItems, settlePage, updateCroAudit } from "../db/cro";
import { BusinessModelResult, BusinessModelSchema, PageReviewResult, PageReviewSchema, SynthesisResult, SynthesisSchema, type ShotKeys } from "../cro/prompts";
import { buildModelRequest, buildPageRequest, buildSynthRequest } from "../cro/stages";
import { MAX_STRENGTHS, applyModeRules, factQuotes, hasTrackingGap, lowItemsWarning, needsRetry, validateRecommendations, validateReview, type Drop } from "../cro/validate";
import { rankRecommendations } from "../cro/pxl";
import { scenarioFor } from "../cro/scenario";
import { shotKey, textKey } from "../cro/keys";
import { startSynthesis } from "../cro/synthesis";
import type { Business } from "../types";
import type { BusinessModel, CroAudit, CroStep, Device, Evidence } from "../cro/types";
import { cancelTasksFor, enqueueTask, type ClaudeTask } from "./db";
import { registerTaskKind, type TaskKindDef } from "./registry";
import { CRO_MODEL_KIND, CRO_PAGE_KIND, CRO_SYNTH_KIND, CRO_TARGET } from "./croKinds";

// The task kinds this file handles: Claude works out how the business makes money, reviews each captured page of its site, then writes the roadmap.
export { CRO_MODEL_KIND, CRO_PAGE_KIND, CRO_SYNTH_KIND, CRO_TARGET };
export const NOT_PICKED_UP = "Claude didn't pick this up in time. Rebuild to try again.";
export const COULDNT_FINISH_MODEL = "Claude couldn't finish reading this business. Rebuild to try again.";
export const COULDNT_FINISH_ROADMAP = "Claude couldn't finish writing the roadmap. Rebuild to try again.";

export const CroModelPayload = z.object({ auditId: z.string().min(1) });
export type CroModelPayload = z.infer<typeof CroModelPayload>;
/** `attempt` 2 is the one retry of a page whose first review had too much thrown away; `rejected` says what and why. */
export const CroPagePayload = z.object({
  auditId: z.string().min(1), pageIndex: z.number().int().min(0), attempt: z.union([z.literal(1), z.literal(2)]), rejected: z.array(z.string()).optional(),
});
export type CroPagePayload = z.infer<typeof CroPagePayload>;
/** `attempt` 2 is the one retry of a roadmap whose first answer had too much thrown away; `rejected` says what and why. */
export const CroSynthPayload = z.object({
  auditId: z.string().min(1), attempt: z.union([z.literal(1), z.literal(2)]), rejected: z.array(z.string()).optional(),
});
export type CroSynthPayload = z.infer<typeof CroSynthPayload>;

const target = (auditId: string) => ({ targetType: CRO_TARGET, targetId: auditId });
// The first try of a page is still claimed while its result is applied, so the retry needs a key of its own to be queued at all.
const pageKey = (auditId: string, index: number, attempt: 1 | 2) => (attempt === 1 ? `${auditId}:${index}` : `${auditId}:${index}:2`);

const enqueuePage = (db: D1Database, auditId: string, pageIndex: number, attempt: 1 | 2, rejected?: string[]) =>
  enqueueTask(db, CRO_PAGE_KIND, { auditId, pageIndex, attempt, ...(rejected ? { rejected } : {}) }, { dedupeKey: pageKey(auditId, pageIndex, attempt), ...target(auditId) });

/** Whether a page of this audit already has a task a worker could pick up (any try): a crash-retry must not queue the page a second time. */
async function pageIsOpen(db: D1Database, auditId: string, pageIndex: number): Promise<boolean> {
  return !!(await db.prepare(
    `SELECT 1 AS x FROM claude_tasks WHERE kind = ? AND target_id = ? AND status IN ('pending','claimed') AND json_extract(payload, '$.pageIndex') = ? LIMIT 1`,
  ).bind(CRO_PAGE_KIND, auditId, pageIndex).first());
}

/**
 * The audit and lead a task is about, or why the result no longer makes sense. An audit the user rebuilt or retried has fresh state (`stages_at` is when
 * its queued stages last started), so a task queued before that belongs to a superseded run and must never write over the newer one. The audit must
 * also still be waiting for Claude, at one of the steps the task belongs to.
 */
async function loadTarget(env: Env, auditId: string, task: ClaudeTask, steps: CroStep[]): Promise<{ stale: string } | { audit: CroAudit; business: Business }> {
  const audit = await getCroAudit(env.DB, auditId);
  if (!audit) return { stale: "the audit no longer exists" };
  if (audit.stages_at && task.created_at < audit.stages_at) return { stale: "the audit was rebuilt after this was queued" };
  if (audit.status !== "waiting") return { stale: `the audit is ${audit.status}, not waiting for Claude` };
  if (!steps.includes(audit.step)) return { stale: `the audit has moved on to ${audit.step}` };
  const business = await getBusiness(env.DB, audit.business_id);
  if (!business) return { stale: "the lead no longer exists" };
  return { audit, business };
}

/** The stored screenshots of the top of a page; a device the capture has none for is left out. */
async function shotsOf(raw: R2Bucket, auditId: string, index: number): Promise<ShotKeys> {
  const key = async (device: Device) => { const k = shotKey(auditId, index, device, true); return (await raw.head(k)) ? k : null; };
  return { desktop: await key("desktop"), mobile: await key("mobile") };
}

/** The ledger lines a page review sees: its own page's, and the site-wide ones (tools and the Google listing). */
const pageEvidence = (all: Evidence[], url: string): Evidence[] => {
  const siteWide = (e: Evidence) => e.family === "martech" || e.family === "listing";
  return [...all.filter((e) => e.page === url && !siteWide(e)), ...all.filter(siteWide)];
};
const retryReasons = (dropped: Drop[]) => dropped.map((d) => `"${d.title}": ${d.reason}`);

/** "N of M pages couldn't be reviewed": the pages that were given up on, counted from what is neither reviewed nor still pending. Null when none were. */
export function skippedWarning(a: Pick<CroAudit, "pages" | "page_reviews" | "pending_pages">): string | null {
  const total = a.pages.filter((p) => p.ok).length;
  const skipped = total - a.page_reviews.length - a.pending_pages.length;
  return skipped > 0 ? `${skipped} of ${total} pages couldn't be reviewed, so the roadmap covers the rest.` : null;
}

/**
 * The page reviews are in (or the pages were given up on): moves the audit to the roadmap stage and hands it over. Does nothing while a page is
 * still pending. Of several completions finishing at once only the one that moves the step hands over, so synthesis is started once. A crash-retry
 * (`retry`) finds the step already moved, cannot know whether the hand-over happened, and does it again: `startSynthesis` is idempotent.
 */
async function finishPages(env: Env, auditId: string, retry = false): Promise<void> {
  const a = await getCroAudit(env.DB, auditId);
  if (!a || a.status !== "waiting" || (a.step !== "pages" && a.step !== "synthesize") || a.pending_pages.length) return;
  if (!a.page_reviews.length) { await failCroAudit(env.DB, auditId, NOT_PICKED_UP); return; } // every page expired: nothing to build a roadmap on
  const warning = skippedWarning(a);
  const moved = await finishPageReviews(env.DB, auditId, { partial: a.pages.some((p) => !p.ok) || warning !== null, warning });
  if (moved || retry) await startSynthesis(env, auditId);
}

/**
 * The time a run of the queued stages starts at. A task queued earlier than it is from a superseded run, so it has to be strictly later than every
 * task this audit has ever had: on a tie (a rebuild in the very millisecond the last task was queued) it waits for the clock to move on.
 */
async function nextRunTime(db: D1Database, auditId: string): Promise<string> {
  const last = (await db.prepare(`SELECT MAX(created_at) AS t FROM claude_tasks WHERE target_type = ? AND target_id = ?`).bind(CRO_TARGET, auditId).first<{ t: string | null }>())?.t;
  if (last && Date.now() <= Date.parse(last)) await new Promise((r) => setTimeout(r, 2));
  return new Date(Math.max(Date.now(), last ? Date.parse(last) + 1 : 0)).toISOString();
}

/**
 * Starts the Claude stages of an audit from `from`, once the workflow has captured the pages (or, for a rebuild or retry, has found them stored). The
 * audit goes `waiting`; nothing here waits for Claude. Open tasks of the audit are cancelled and `stages_at` is set first, so a result still on its way
 * from an earlier run is discarded as stale. Safe to run again: it just starts over.
 */
export async function startCroStages(env: Env, auditId: string, from: "model" | "pages" | "synthesize" = "model"): Promise<void> {
  const audit = await getCroAudit(env.DB, auditId);
  if (!audit) throw new Error(`CRO audit ${auditId} not found`);
  const indexes = audit.pages.filter((p) => p.ok).map((p) => p.index);
  const fresh = { status: "waiting" as const, error: null, warning: null, partial: audit.pages.some((p) => !p.ok), stages_at: await nextRunTime(env.DB, auditId) };
  if (from !== "model" && !audit.business_model) throw new Error("No business model to build on; run the full audit first");

  if (from === "model") {
    await updateCroAudit(env.DB, auditId, { ...fresh, step: "model", pending_pages: [] });
    await cancelTasksFor(env.DB, CRO_TARGET, auditId);
    await enqueueTask(env.DB, CRO_MODEL_KIND, { auditId }, { dedupeKey: auditId, ...target(auditId) });
  } else if (from === "pages") {
    // The reviews are redone for the model in force now, so the old ones go.
    const model: BusinessModel = { ...audit.business_model!, ...audit.model_overrides };
    await updateCroAudit(env.DB, auditId, { ...fresh, step: "pages", page_reviews: [], pending_pages: indexes, reviewed_as: model.model });
    await cancelTasksFor(env.DB, CRO_TARGET, auditId);
    for (const i of indexes) await enqueuePage(env.DB, auditId, i, 1);
  } else {
    await updateCroAudit(env.DB, auditId, { ...fresh, step: "synthesize", pending_pages: [] });
    await cancelTasksFor(env.DB, CRO_TARGET, auditId);
    await startSynthesis(env, auditId);
  }
}

/** Whether a task that ended (expired or failed) belongs to the audit's current run; an old run's must not disturb a rebuilt audit. */
const current = (a: CroAudit, task?: ClaudeTask) => !(task && a.stages_at && task.created_at < a.stages_at);

/** The model stage can never be answered (nobody picked it up, or Claude gave up on it): the audit fails with `message`. */
async function failModel(env: Env, auditId: string, message: string, task?: ClaudeTask): Promise<void> {
  const a = await getCroAudit(env.DB, auditId);
  if (a && a.status === "waiting" && a.step === "model" && current(a, task)) await failCroAudit(env.DB, a.id, message);
}

/** The roadmap can never be written (nobody picked it up, or Claude gave up on it): the audit fails with `message`. Only an audit still waiting on the roadmap of this run. */
async function failRoadmap(env: Env, auditId: string, message: string, task?: ClaudeTask): Promise<void> {
  const a = await getCroAudit(env.DB, auditId);
  if (a && a.status === "waiting" && a.step === "synthesize" && current(a, task)) await failCroAudit(env.DB, a.id, message);
}

/**
 * A page can never be reviewed: it leaves `pending_pages` (counted as skipped; `finishPages` writes the warning) and, if it was the last one, the audit
 * moves on. Safe to run again: a page already settled changes nothing, and the hand-over is retried in case an earlier run stopped before it. That
 * retry is also what heals an audit whose last page was settled but whose roadmap was never queued: any page task of the audit ending (expired or
 * failed) re-runs the hand-over, even with the step already on the roadmap.
 */
async function skipPage(env: Env, auditId: string, pageIndex: number, task?: ClaudeTask): Promise<void> {
  const a = await getCroAudit(env.DB, auditId);
  // At the roadmap step already: an earlier hand-over may have stopped before queuing the roadmap, and this is a chance to finish it (`finishPages` is idempotent).
  if (!a || a.status !== "waiting" || (a.step !== "pages" && a.step !== "synthesize") || !current(a, task)) return;
  const settled = await settlePage(env.DB, a.id, pageIndex, null);
  await finishPages(env, a.id, settled === null);
}

/**
 * Re-runs the hand-over to the roadmap for an audit that is waiting at the roadmap step of the current run (`task` is the stale task asking, if any: one
 * from a superseded run changes nothing). The hand-over is idempotent (`startSynthesis` does nothing while a roadmap task is open), so this is safe to call
 * from anywhere, any number of times. Best effort: it never throws, so a caller (a briefing that is about to be closed, a status read) is never broken by it.
 *
 * It exists because the hand-over can stop after the step moved on (the queue write failed) and the page task that would have retried it then ends
 * without running a hook (a reclaimed task found stale is closed silently), or its hook failed too. Nothing else would ever queue the roadmap.
 */
export async function healCroHandover(env: Env, auditId: string, task?: ClaudeTask): Promise<void> {
  try {
    const a = await getCroAudit(env.DB, auditId);
    if (!a || a.status !== "waiting" || a.step !== "synthesize" || !current(a, task)) return;
    await finishPages(env, a.id, true);
  } catch (e) { console.warn("healing the CRO hand-over failed for", auditId, e); }
}

/** Heals every audit waiting at the roadmap step with no roadmap task open (see `healCroHandover`). For a periodic sweep. Returns how many audits it looked at. */
export async function healCroHandovers(env: Env): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT id FROM cro_audits WHERE status = 'waiting' AND step = 'synthesize' AND NOT EXISTS (
       SELECT 1 FROM claude_tasks WHERE kind = ? AND target_type = ? AND target_id = cro_audits.id AND status IN ('pending','claimed')) LIMIT 100`,
  ).bind(CRO_SYNTH_KIND, CRO_TARGET).all<{ id: string }>()).results;
  for (const r of rows) await healCroHandover(env, r.id);
  return rows.length;
}

const croModel: TaskKindDef<CroModelPayload, z.infer<typeof BusinessModelResult>> = {
  kind: CRO_MODEL_KIND,
  label: "Work out how a business makes money",
  suggestedModel: "haiku",
  payload: CroModelPayload,
  result: BusinessModelResult,

  /** The home page's screenshots, the business and the evidence ledger all came from the site or its listing: untrusted. The instructions are the fixed stage prompt. */
  async build(env, p, task) {
    const t = await loadTarget(env, p.auditId, task, ["model"]);
    if ("stale" in t) return t;
    const home = t.audit.pages.find((x) => x.ok);
    if (!home) return { stale: "no page was captured" };
    return buildModelRequest({ business: t.business, evidence: t.audit.evidence, shots: await shotsOf(env.RAW, t.audit.id, home.index) });
  },

  /**
   * Saves the business model and queues one review per captured page. A crash-retry finds the audit already on the pages step and only makes sure each
   * pending page is queued (once: a page that has a task open is left alone), so the model is never overwritten and no page is queued twice.
   */
  async apply(env, p, r, task) {
    const t = await loadTarget(env, p.auditId, task, ["model", "pages"]);
    if ("stale" in t) return t;
    const { audit, business } = t;
    if (audit.step === "model") {
      const model = BusinessModelSchema.parse(r);
      const indexes = audit.pages.filter((x) => x.ok).map((x) => x.index);
      const moved = await beginPageReviews(env.DB, audit.id, { model, reviewedAs: ({ ...model, ...audit.model_overrides }).model, indexes, notBefore: task.created_at });
      if (!moved && (await getCroAudit(env.DB, audit.id))?.step !== "pages") return { stale: "the audit changed while the result was being applied" };
    }
    const now = await getCroAudit(env.DB, audit.id);
    if (!now || now.status !== "waiting" || now.step !== "pages") return { stale: "the audit changed while the result was being applied" };
    for (const i of now.pending_pages) if (!(await pageIsOpen(env.DB, audit.id, i))) await enqueuePage(env.DB, audit.id, i, 1);
    return { log: { summary: `worked out how ${business.name.slice(0, 100)} makes money; ${now.pending_pages.length} page${now.pending_pages.length === 1 ? "" : "s"} to review`, recordType: "lead", recordId: business.id } };
  },

  /** Nobody picked it up: there is nothing to build on, so the audit fails and says how to try again. */
  async onExpire(env, p) { await failModel(env, p.auditId, NOT_PICKED_UP); },
  /** Claude gave up on it (claimed over and over, or refused for good): same, with its own message. A failure from a superseded run leaves the rebuilt audit alone. */
  async onFail(env, p, _error, task) { await failModel(env, p.auditId, COULDNT_FINISH_MODEL, task); },
};

const croPage: TaskKindDef<CroPagePayload, z.infer<typeof PageReviewResult>> = {
  kind: CRO_PAGE_KIND,
  label: "Review one page of a website",
  suggestedModel: "sonnet",
  payload: CroPagePayload,
  result: PageReviewResult,

  /** The page's screenshots, the business, the model card (derived from the site) and the ledger are untrusted; so are the reasons an earlier try was thrown away. */
  async build(env, p, task) {
    const t = await loadTarget(env, p.auditId, task, ["pages"]);
    // The audit already moved on to the roadmap: this page was settled, and the task being closed as stale is the last chance to see that the roadmap got queued.
    if ("stale" in t) { await healCroHandover(env, p.auditId, task); return t; }
    const { audit, business } = t;
    if (!audit.pending_pages.includes(p.pageIndex)) return { stale: "this page was already reviewed or skipped" };
    const page = audit.pages.find((x) => x.index === p.pageIndex && x.ok);
    if (!page || !audit.business_model) return { stale: "there is no captured page to review" };
    const model: BusinessModel = { ...audit.business_model, ...audit.model_overrides };
    return buildPageRequest({ business, model, page, evidence: pageEvidence(audit.evidence, page.url), shots: await shotsOf(env.RAW, audit.id, page.index) }, p.rejected ?? []);
  },

  /**
   * Checks the review against the evidence ledger and the page's own text, as the inline stage did. A first try with too much thrown away is asked
   * for once more (with the reasons), and the second try is kept as it is. A kept review is appended and the page leaves `pending_pages` in one
   * statement, so a crash-retry (or a second session) finds the page no longer pending and only repeats the hand-over to the roadmap, which is idempotent.
   */
  async apply(env, p, r, task) {
    const t = await loadTarget(env, p.auditId, task, ["pages", "synthesize"]);
    if ("stale" in t) return t;
    const { audit, business } = t;
    const page = audit.pages.find((x) => x.index === p.pageIndex && x.ok);
    if (!page) return { stale: "there is no captured page to review" };
    const log = (what: string) => ({ log: { summary: `${what} page ${p.pageIndex + 1} of ${business.name.slice(0, 100)}`, recordType: "lead", recordId: business.id } });
    const reviewed = (a: CroAudit) => a.page_reviews.some((x) => x.page === page.url);

    if (!audit.pending_pages.includes(p.pageIndex)) {
      // Already settled: this completion ran before (it crashed after saving) or the page was given up on since.
      if (!reviewed(audit)) { await healCroHandover(env, audit.id, task); return { stale: "this page was skipped meanwhile" }; }
      await finishPages(env, audit.id, true);
      return log("reviewed");
    }
    if (audit.step !== "pages") return { stale: `the audit has moved on to ${audit.step}` };

    const ids = new Set(audit.evidence.map((e) => e.id));
    // Quotes are checked against this page's text plus phrases a fact quotes (placeholders and labels aren't in the page text); never whole facts.
    const texts = [(await (await env.RAW.get(textKey(audit.id, page.index)))?.text()) ?? "", ...factQuotes(audit.evidence.map((e) => e.fact))];
    const review = { ...PageReviewSchema.parse(r), page: page.url };
    const v = validateReview(review, ids, texts);
    if (p.attempt === 1 && needsRetry(review.issues.length, v.dropped.length)) {
      await enqueuePage(env.DB, audit.id, page.index, 2, retryReasons(v.dropped));
      return log("asked again about");
    }
    if ((await settlePage(env.DB, audit.id, page.index, v.review, task.created_at)) === null) {
      // Lost a race: settled in between by another completion of this page (fine) or the audit was rebuilt (stale).
      const now = await getCroAudit(env.DB, audit.id);
      if (!now || !reviewed(now) || (now.stages_at && task.created_at < now.stages_at)) return { stale: "the audit changed while the result was being applied" };
    }
    await finishPages(env, audit.id);
    return log("reviewed");
  },

  /** Nobody picked the page up: it is counted as skipped and the audit goes on with the rest. With no review at all it fails, like the model stage. */
  async onExpire(env, p) { await skipPage(env, p.auditId, p.pageIndex); },
  /** Claude gave up on the page: counted as skipped, exactly like an expiry. A failure from a superseded run leaves the rebuilt audit alone. */
  async onFail(env, p, _error, task) { await skipPage(env, p.auditId, p.pageIndex, task); },
};

/** The roadmap's second try needs a key of its own for the same reason a page's does: the first is still claimed while its result is applied. */
const synthKey = (auditId: string, attempt: 1 | 2) => (attempt === 1 ? auditId : `${auditId}:2`);

const croSynth: TaskKindDef<CroSynthPayload, z.infer<typeof SynthesisResult>> = {
  kind: CRO_SYNTH_KIND,
  label: "Write the conversion roadmap for a website",
  suggestedModel: "sonnet",
  payload: CroSynthPayload,
  result: SynthesisResult,

  /** The page reviews quote the site, and the business, the model card and the ledger are derived from it: all untrusted, like the reasons an earlier try was thrown away. */
  async build(env, p, task) {
    const t = await loadTarget(env, p.auditId, task, ["synthesize"]);
    if ("stale" in t) return t;
    const { audit, business } = t;
    if (!audit.business_model || !audit.page_reviews.length) return { stale: "there is nothing to build a roadmap on" };
    const model: BusinessModel = { ...audit.business_model, ...audit.model_overrides };
    return buildSynthRequest({ business, model, reviews: audit.page_reviews, evidence: audit.evidence }, p.rejected ?? []);
  },

  /**
   * Checks the recommendations against the evidence ledger and the captured pages' text, as the inline stage did. A first try with too much thrown away
   * is asked for once more (with the reasons), and the second try is kept as it is. A kept roadmap is ranked and written, and the audit finished in one
   * guarded statement. A crash-retry rewrites the items (replacing them is idempotent) and finishes; one that finds the audit already done is stale,
   * so the same roadmap is never written twice and a second answer never overwrites the first.
   */
  async apply(env, p, r, task) {
    const t = await loadTarget(env, p.auditId, task, ["synthesize"]);
    if ("stale" in t) return t;
    const { audit, business } = t;
    if (!audit.business_model) return { stale: "there is no business model to build on" };
    const model: BusinessModel = { ...audit.business_model, ...audit.model_overrides };
    const log = (what: string) => ({ log: { summary: `${what} ${business.name.slice(0, 100)}`, recordType: "lead", recordId: business.id } });

    const ids = new Set(audit.evidence.map((e) => e.id));
    // Quotes are checked against the text of every captured page plus phrases a fact quotes; never whole facts.
    const pageTexts = await Promise.all(audit.pages.filter((x) => x.ok).map(async (x) => (await (await env.RAW.get(textKey(audit.id, x.index)))?.text()) ?? ""));
    const out = SynthesisSchema.parse(r);
    const v = validateRecommendations(out.recommendations, ids, [...pageTexts, ...factQuotes(audit.evidence.map((e) => e.fact))]);
    // The drop share is measured against what the model returned, before any cap.
    if (p.attempt === 1 && needsRetry(out.recommendations.length, v.dropped.length)) {
      await enqueueTask(env.DB, CRO_SYNTH_KIND, { auditId: audit.id, attempt: 2, rejected: retryReasons(v.dropped) }, { dedupeKey: synthKey(audit.id, 2), ...target(audit.id) });
      return log("asked again for the roadmap of");
    }
    const ranked = rankRecommendations(applyModeRules(v.kept, model.traffic_tier), audit.evidence, model.model, { trackingGap: hasTrackingGap(audit.evidence) });
    await replaceCroItems(env.DB, audit.id, ranked);
    const done = await finishRoadmap(env.DB, audit.id, {
      strengths: out.strengths.slice(0, MAX_STRENGTHS), positioning: out.positioning, tracking_plan: out.tracking_plan,
      scenario_inputs: scenarioFor(audit.scenario_inputs, model),
      // The note about skipped pages was written when the reviews were in; this adds the one about a thin roadmap in front of it.
      warning: [lowItemsWarning(ranked.length), audit.warning].filter(Boolean).join(" ") || null,
      completedAt: new Date().toISOString(), notBefore: task.created_at,
    });
    if (!done) return { stale: "the audit changed while the result was being applied" };
    return log(`wrote the roadmap (${ranked.length} recommendation${ranked.length === 1 ? "" : "s"}) for`);
  },

  /** Nobody picked it up: the audit fails and says how to try again. */
  async onExpire(env, p) { await failRoadmap(env, p.auditId, NOT_PICKED_UP); },
  /** Claude gave up on it: same, with its own message. A failure from a superseded run leaves the rebuilt audit alone. */
  async onFail(env, p, _error, task) { await failRoadmap(env, p.auditId, COULDNT_FINISH_ROADMAP, task); },
};

registerTaskKind(croModel);
registerTaskKind(croPage);
registerTaskKind(croSynth);
