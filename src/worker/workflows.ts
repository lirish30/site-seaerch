import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { runLead, type LeadDeps, type StepLike } from "./pipeline/lead";
import { anthropicCaller } from "./drafter/draft";
import { setBusinessError } from "./db/businesses";
import { incrementProcessed } from "./db/searches";

const RETRY = { retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export function depsFromEnv(env: Env): LeadDeps {
  return {
    db: env.DB, raw: env.RAW, fetch: (u, i) => fetch(u, i), pagespeedKey: env.PAGESPEED_API_KEY,
    claude: anthropicCaller(env.ANTHROPIC_API_KEY), now: () => new Date(),
  };
}

export function adaptStep(step: WorkflowStep): StepLike {
  return {
    do: (name, fn) => step.do(name, RETRY, fn as any) as any,
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export type LeadParams = { businessId: string; searchId: string | null; forceDraft?: boolean };

export class LeadWorkflow extends WorkflowEntrypoint<Env, LeadParams> {
  async run(event: WorkflowEvent<LeadParams>, step: WorkflowStep) {
    const deps = depsFromEnv(this.env);
    const p = event.payload;
    try {
      await step.do("clear-error", () => setBusinessError(deps.db, p.businessId, null).then(() => true));
      return await runLead(deps, adaptStep(step), p);
    } catch (e) {
      await step.do("record-error", async () => {
        await setBusinessError(deps.db, p.businessId, (e as Error).message.slice(0, 500));
        if (p.searchId) await incrementProcessed(deps.db, p.searchId);
        return true;
      });
      return { auditId: null, draftId: null };
    }
  }
}

export type SearchParams = { searchId: string };

export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(_event: WorkflowEvent<SearchParams>, _step: WorkflowStep) {
    // Implemented in Task 13
  }
}
