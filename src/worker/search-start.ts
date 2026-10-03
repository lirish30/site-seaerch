import { z } from "zod";
import type { Search } from "./types";
import { createSearch, setSearchStatus } from "./db/searches";
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
export type StartResult = { ok: true; search: Search; estUsd: number } | StartFailure;

/**
 * The one place that decides whether a paid search may begin. The manual route and Radar both go through it,
 * so a scheduled run can never skip a guard. `extraUsd` is spend already committed but not yet recorded
 * (workflows only write `usage` as they run), e.g. searches started earlier in the same cron tick.
 */
export async function checkSearchGuards(db: D1Database, input: unknown, extraUsd = 0):
  Promise<{ ok: true; data: SearchInput; estUsd: number } | Exclude<StartFailure, { kind: "start_failed" }>> {
  const parsed = NewSearch.safeParse(input);
  if (!parsed.success) return { ok: false, kind: "invalid", error: parsed.error.issues.map((i) => i.message).join("; ") };
  if (await mailingSettingsMissing(db)) return { ok: false, kind: "compliance", error: MISSING_MAILING_SETTINGS };
  const estUsd = estimateSearchCost(parsed.data.maxResults);
  const spend = await checkSpend(db, estUsd + extraUsd);
  if (!spend.ok) return { ok: false, kind: "spend", spend };
  return { ok: true, data: parsed.data, estUsd };
}

export async function startSearchRun(
  deps: { db: D1Database; startWorkflow: (searchId: string) => Promise<unknown> },
  input: unknown,
  extraUsd = 0,
): Promise<StartResult> {
  const g = await checkSearchGuards(deps.db, input, extraUsd);
  if (!g.ok) return g;
  const search = await createSearch(deps.db, g.data);
  try {
    await deps.startWorkflow(search.id);
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    await setSearchStatus(deps.db, search.id, "failed", error);
    return { ok: false, kind: "start_failed", error };
  }
  return { ok: true, search, estUsd: g.estUsd };
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
