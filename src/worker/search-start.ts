import { z } from "zod";
import type { Search } from "./types";
import type { Env } from "./env";
import { createSearch, runningMaxResultsSince, setSearchStatus } from "./db/searches";
import { checkSpend, estimateSearchCost } from "./cost";
import { mailingSettingsMissing, MISSING_MAILING_SETTINGS } from "./routes/compliance";

export const NewSearch = z.object({
  location: z.string().trim().min(2),
  businessType: z.string().trim().min(2),
  radiusKm: z.number().min(1).max(100).default(15),
  maxResults: z.number().int().min(1).max(200).default(50),
});
export type SearchInput = z.infer<typeof NewSearch>;

export type SpendCheck = Awaited<ReturnType<typeof checkSpend>>;
export type StartFailure =
  | { ok: false; kind: "invalid"; error: string }
  | { ok: false; kind: "compliance"; error: string }
  | { ok: false; kind: "spend"; spend: SpendCheck }
  | { ok: false; kind: "start_failed"; error: string };
export type StartResult = { ok: true; search: Search } | StartFailure;

// Workflows write `usage` only as they run, so a just-started search is invisible to checkSpend. Searches still
// 'running' this recently are counted at their estimated cost instead. Counting one whose usage is already partly
// recorded double-counts a little, which errs on the safe side; a stuck 'running' row stops counting after the window.
export const IN_FLIGHT_WINDOW_HOURS = 6;

export async function inFlightUsd(db: D1Database): Promise<number> {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_HOURS * 3600000).toISOString();
  return (await runningMaxResultsSince(db, since)).reduce((sum, n) => sum + estimateSearchCost(n), 0);
}

/**
 * The one place that decides whether a paid search may begin. The manual route, Run now and the cron all go
 * through it, so a scheduled run can never skip a guard. In-flight searches (including ones this same cron tick
 * just created) are counted from the database only, never also by hand, so nothing is counted twice.
 */
export async function checkSearchGuards(db: D1Database, input: unknown):
  Promise<{ ok: true; data: SearchInput } | Exclude<StartFailure, { kind: "start_failed" }>> {
  const parsed = NewSearch.safeParse(input);
  if (!parsed.success) return { ok: false, kind: "invalid", error: parsed.error.issues.map((i) => i.message).join("; ") };
  if (await mailingSettingsMissing(db)) return { ok: false, kind: "compliance", error: MISSING_MAILING_SETTINGS };
  const spend = await checkSpend(db, estimateSearchCost(parsed.data.maxResults) + (await inFlightUsd(db)));
  if (!spend.ok) return { ok: false, kind: "spend", spend };
  return { ok: true, data: parsed.data };
}

export async function startSearchRun(
  deps: { db: D1Database; startWorkflow: (searchId: string) => Promise<unknown> },
  input: unknown,
  opts: { newOnly?: boolean } = {},
): Promise<StartResult> {
  const g = await checkSearchGuards(deps.db, input);
  if (!g.ok) return g;
  // newOnly (Radar) changes what the workflow does per lead, not what it may cost: the estimate stays maxResults drafts.
  const search = await createSearch(deps.db, g.data, { newOnly: opts.newOnly });
  // Requests arriving together all read the same in-flight total above. Now that our row exists (and counts), check
  // again: alone this is the same math as the pre-check; under a true race it may reject every racer, which is the
  // safe direction for a spend guard.
  const spend = await checkSpend(deps.db, await inFlightUsd(deps.db));
  if (!spend.ok) {
    await setSearchStatus(deps.db, search.id, "failed", "spend limit");
    return { ok: false, kind: "spend", spend };
  }
  try {
    await deps.startWorkflow(search.id);
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 500); // workflows can throw non-Errors
    await setSearchStatus(deps.db, search.id, "failed", error);
    return { ok: false, kind: "start_failed", error };
  }
  return { ok: true, search };
}

/** HTTP mapping shared by every route that starts a search, so statuses and bodies cannot drift. */
export function failureResponse(f: StartFailure): { status: 400 | 402 | 502; body: Record<string, unknown> } {
  if (f.kind === "spend") return { status: 402, body: { error: "spend limit", ...f.spend } };
  if (f.kind === "start_failed") return { status: 502, body: { error: f.error } };
  return { status: 400, body: { error: f.error } };
}

/** Short human text for a radar's last_error. */
export function failureMessage(f: StartFailure): string {
  return f.kind === "spend" ? `Spend limit: $${f.spend.spent.toFixed(2)} spent of $${f.spend.limit.toFixed(2)} this month` : f.error;
}

export const searchWorkflowStarter = (env: Pick<Env, "SEARCH_WORKFLOW">) => (searchId: string) =>
  env.SEARCH_WORKFLOW.create({ id: `search-${searchId}`, params: { searchId } });
