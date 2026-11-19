import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { runLead, type LeadDeps, type StepLike } from "./pipeline/lead";
import { browserRenderer } from "./render/render";
import { setBusinessError } from "./db/businesses";
import { incrementProcessed } from "./db/searches";
import { runSearch } from "./pipeline/search";
import type { ScanStage } from "./types";
import { BrightDataListingSource } from "./listings/brightdata";
import { GooglePlacesListingSource } from "./listings/places";
import { FallbackListingSource } from "./listings/fallback";
import { runCroWithErrorHandling, startCroStages, type CroDeps, type CroParams } from "./cro/pipeline";
import { puppeteerCroBrowser } from "./cro/capture";
import { runVideoWithErrorHandling, type VideoParams } from "./video/pipeline";

const RETRY = { retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };
// Bright Data's Maps scraper fails in bursts (HTTP 502 maps_ajax_failed / no_ready_cookies), but a search that is still
// failing after a few minutes is not going to recover on its own: retry 3 times (20s, 40s, 80s apart), then fail with the
// real error so the user can re-run it. The step timeout sits above the listing sources' own deadlines (each stops paging at 120s and
// aborts a request at 45s, and the Places-then-Bright Data fallback can run both), so a source gives up first and the failure is
// recorded rather than the engine killing the step silently.
export const LISTING_RETRY = { retries: { limit: 3, delay: "20 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export function depsFromEnv(env: Env): LeadDeps {
  return {
    db: env.DB, raw: env.RAW, fetch: (u, i) => fetch(u, i), pagespeedKey: env.PAGESPEED_API_KEY,
    now: () => new Date(),
    render: env.BROWSER ? browserRenderer(env.BROWSER) : undefined,
  };
}

export function adaptStep(step: WorkflowStep): StepLike {
  return {
    do: (name, fn) => step.do(name, /^fetch-listings(-\d+)?$/.test(name) ? LISTING_RETRY : RETRY, fn as any) as any,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export type LeadParams = { businessId: string; searchId: string | null; forceDraft?: boolean; stage?: ScanStage };

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
    return { auditId: null };
  }
}

export class LeadWorkflow extends WorkflowEntrypoint<Env, LeadParams> {
  async run(event: WorkflowEvent<LeadParams>, step: WorkflowStep) {
    return runLeadWithErrorHandling(depsFromEnv(this.env), step, event.payload);
  }
}

export type SearchParams = { searchId: string };

export async function startLeadIdempotent(
  binding: Pick<Workflow, "create" | "get">, p: { businessId: string; searchId: string; stage?: ScanStage },
) {
  const id = `lead-${p.searchId}-${p.businessId}`;
  try {
    await binding.create({ id, params: { businessId: p.businessId, searchId: p.searchId, stage: p.stage ?? "full" } });
  } catch (e) {
    const existing = await binding.get(id).catch(() => null);
    if (existing) return; // already started by a previous attempt
    throw e;
  }
}

export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(event: WorkflowEvent<SearchParams>, step: WorkflowStep) {
    const env = this.env;
    const brightData = new BrightDataListingSource({ apiKey: env.BRIGHTDATA_API_KEY, zone: env.BRIGHTDATA_SERP_ZONE, fetch: (u, i) => fetch(u, i) });
    // Places is Google's own API, so it goes first; Bright Data (a Maps scrape that has been failing in bursts) is the fallback.
    const source = env.GOOGLE_PLACES_API_KEY
      ? new FallbackListingSource([new GooglePlacesListingSource({ apiKey: env.GOOGLE_PLACES_API_KEY, fetch: (u, i) => fetch(u, i) }), brightData])
      : brightData;
    await runSearch({
      db: env.DB, source,
      startLead: (p) => startLeadIdempotent(env.LEAD_WORKFLOW, p),
    }, adaptStep(step), event.payload.searchId);
  }
}

export function croDepsFromEnv(env: Env): CroDeps {
  // No AI caller: the Claude stages are queued for Claude Code to work (startCroStages), and the workflow ends after capture and evidence.
  return { db: env.DB, raw: env.RAW, browser: env.BROWSER ? puppeteerCroBrowser(env.BROWSER) : undefined, now: () => new Date(),
    start: (auditId, from) => startCroStages(env, auditId, from) };
}

export class CroAuditWorkflow extends WorkflowEntrypoint<Env, CroParams> {
  async run(event: WorkflowEvent<CroParams>, step: WorkflowStep) {
    return runCroWithErrorHandling(croDepsFromEnv(this.env), adaptStep(step), event.payload);
  }
}

export class VideoAuditWorkflow extends WorkflowEntrypoint<Env, VideoParams> {
  async run(event: WorkflowEvent<VideoParams>, step: WorkflowStep) {
    return runVideoWithErrorHandling(this.env, adaptStep(step), event.payload);
  }
}
