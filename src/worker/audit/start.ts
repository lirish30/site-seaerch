import type { Env } from "../env";
import { checkSpend, PER_LEAD_COST } from "../cost";
import { logActivity } from "../db/activity";
import { getBusiness } from "../db/businesses";

export type FullScanResult =
  | { ok: true }
  | { ok: false; status: 402 | 404 | 502; error: "not found" | "spend limit" | string; spend?: { ok: boolean; spent: number; limit: number } };

/**
 * Pays for the rest of a quick-scanned lead (screenshots, PageSpeed, AI review, draft) by starting the lead workflow at its full stage. Any lead may be re-run this way;
 * the draft step skips a suppressed lead itself, so there is no suppression check here. Answers "not found" for an unknown id, "spend limit" (with the figures) when the
 * month's cap would be passed, and the workflow's own message when it cannot start. Writes the `reaudit` activity line only once the workflow is started.
 */
export async function startFullScan(env: Env, businessId: string): Promise<FullScanResult> {
  if (!(await getBusiness(env.DB, businessId))) return { ok: false, status: 404, error: "not found" };
  const spend = await checkSpend(env.DB, PER_LEAD_COST);
  if (!spend.ok) return { ok: false, status: 402, error: "spend limit", spend };
  try {
    await env.LEAD_WORKFLOW.create({ id: `fullscan-${businessId}-${Date.now()}`, params: { businessId, searchId: null, forceDraft: false, stage: "full" } });
  } catch (e) {
    return { ok: false, status: 502, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await logActivity(env.DB, businessId, "reaudit", "Full scan");
  return { ok: true };
}
