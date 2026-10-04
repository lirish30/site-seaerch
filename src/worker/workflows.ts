import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { runLead, type LeadDeps, type StepLike } from "./pipeline/lead";
import { anthropicCaller } from "./drafter/draft";
import { anthropicReviewer } from "./audit/review";
import { browserRenderer } from "./render/render";
import { setBusinessError } from "./db/businesses";
import { incrementProcessed } from "./db/searches";
import { runSearch } from "./pipeline/search";
import { BrightDataListingSource } from "./listings/brightdata";
import { runCroWithErrorHandling, type CroDeps, type CroParams } from "./cro/pipeline";
import { anthropicCroCaller } from "./cro/ai";
import { puppeteerCroBrowser } from "./cro/capture";

const RETRY = { retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };
// Bright Data's Maps scraper fails in bursts (HTTP 502 maps_ajax_failed), so the listing fetch backs off longer: ~15 min of retries.
const LISTING_RETRY = { retries: { limit: 5, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export function depsFromEnv(env: Env): LeadDeps {
  return {
    db: env.DB, raw: env.RAW, fetch: (u, i) => fetch(u, i), pagespeedKey: env.PAGESPEED_API_KEY,
    claude: anthropicCaller(env.ANTHROPIC_API_KEY), now: () => new Date(),
    render: env.BROWSER ? browserRenderer(env.BROWSER) : undefined,
    reviewer: anthropicReviewer(env.ANTHROPIC_API_KEY),
  };
}

export function adaptStep(step: WorkflowStep): StepLike {
  return {
    do: (name, fn) => step.do(name, name === "fetch-listings" ? LISTING_RETRY : RETRY, fn as any) as any,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export type LeadParams = { businessId: string; searchId: string | null; forceDraft?: boolean };

export async function runLeadWithErrorHandling(deps: LeadDeps, step: WorkflowStep, p: LeadParams) {
  try {
    await step.do("clear-error", () => setBusinessError(deps.db, p.businessId, null).then(() => true));
    return await runLead(deps, adaptStep(step), p);
  } catch (e) {
    const message = String((e as any)?.message ?? e).slice(0, 500);
    await step.do("record-error", async () => {
      await setBusinessError(deps.db, p.businessId, message);
      if (p.searchId) await incrementProcessed(deps.db, p.searchId);
      return true;
    });
    return { auditId: null, draftId: null };
  }
}

export class LeadWorkflow extends WorkflowEntrypoint<Env, LeadParams> {
  async run(event: WorkflowEvent<LeadParams>, step: WorkflowStep) {
    return runLeadWithErrorHandling(depsFromEnv(this.env), step, event.payload);
  }
}

export type SearchParams = { searchId: string };

export async function startLeadIdempotent(
  binding: Pick<Workflow, "create" | "get">, p: { businessId: string; searchId: string },
) {
  const id = `lead-${p.searchId}-${p.businessId}`;
  try {
    await binding.create({ id, params: { businessId: p.businessId, searchId: p.searchId } });
  } catch (e) {
    const existing = await binding.get(id).catch(() => null);
    if (existing) return; // already started by a previous attempt
    throw e;
  }
}

export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(event: WorkflowEvent<SearchParams>, step: WorkflowStep) {
    const env = this.env;
    const source = new BrightDataListingSource({ apiKey: env.BRIGHTDATA_API_KEY, zone: env.BRIGHTDATA_SERP_ZONE, fetch: (u, i) => fetch(u, i) });
    await runSearch({
      db: env.DB, source,
      startLead: (p) => startLeadIdempotent(env.LEAD_WORKFLOW, p),
    }, adaptStep(step), event.payload.searchId);
  }
}

export function croDepsFromEnv(env: Env): CroDeps {
  return { db: env.DB, raw: env.RAW, browser: env.BROWSER ? puppeteerCroBrowser(env.BROWSER) : undefined,
    ai: anthropicCroCaller(env.ANTHROPIC_API_KEY), now: () => new Date() };
}

export class CroAuditWorkflow extends WorkflowEntrypoint<Env, CroParams> {
  async run(event: WorkflowEvent<CroParams>, step: WorkflowStep) {
    return runCroWithErrorHandling(croDepsFromEnv(this.env), adaptStep(step), event.payload);
  }
}
