import type { Radar, Search } from "./types";
import { addDays, claimRadar, listDueRadars, recordRadarBlocked, recordRadarStarted } from "./db/radar";
import { failureMessage, startSearchRun, type StartFailure, type StartResult } from "./search-start";

// Bounds an unattended burst: one cron tick starts at most this many searches; the rest wait for the next tick.
export const DEFAULT_MAX_PER_RUN = 3;
// A blocked or failed radar retries tomorrow rather than skipping a whole interval.
export const RETRY_DAYS = 1;

export type RadarDeps = { db: D1Database; startWorkflow: (searchId: string) => Promise<unknown>; now: () => Date };
export type RadarOutcome =
  | { status: "started"; search: Search }
  | { status: "claim_lost" }
  | { status: "blocked"; failure: StartFailure };

/**
 * Claim, then start, one radar through the same guards as the manual search route. The claim comes first
 * (single-statement compare-and-set, see claimRadar) so a duplicate cron delivery or double-click can never start
 * it twice; the cost of that ordering is that a crash after the claim skips this interval instead of risking a
 * double spend. Once the workflow has started, nothing after it may reschedule the radar or hide the spend.
 */
export async function runRadar(deps: RadarDeps, radar: Radar, opts: { manual?: boolean } = {}): Promise<RadarOutcome> {
  const now = deps.now(); const nowIso = now.toISOString();
  const claimed = await claimRadar(deps.db, radar.id, addDays(now, radar.interval_days), nowIso, !opts.manual);
  if (!claimed) return { status: "claim_lost" };
  let r: StartResult;
  try {
    r = await startSearchRun(deps, { location: claimed.location, businessType: claimed.business_type, radiusKm: claimed.radius_km, maxResults: claimed.max_results }, { newOnly: true });
  } catch (e) {
    r = { ok: false, kind: "start_failed", error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
  if (r.ok) {
    // The search row is already 'running', which is what counts its spend; losing this bookkeeping must not undo that.
    await recordRadarStarted(deps.db, radar.id, r.search.id, nowIso).catch((e) => console.error("radar record failed", e));
    return { status: "started", search: r.search };
  }
  // A manual run of a radar that isn't due yet keeps its schedule; a due radar retries tomorrow.
  await recordRadarBlocked(deps.db, radar.id, failureMessage(r), radar.next_run_at > nowIso ? radar.next_run_at : addDays(now, RETRY_DAYS));
  return { status: "blocked", failure: r };
}

export async function runDueRadars(deps: RadarDeps, opts: { maxPerRun?: number } = {}) {
  const summary = { started: 0, skipped: 0, failed: 0 };
  const due = await listDueRadars(deps.db, deps.now().toISOString(), opts.maxPerRun ?? DEFAULT_MAX_PER_RUN);
  for (const radar of due) {
    try {
      const o = await runRadar(deps, radar);
      if (o.status === "started") summary.started++;
      else if (o.status === "claim_lost" || o.failure.kind === "spend" || o.failure.kind === "compliance") summary.skipped++;
      else summary.failed++;
    } catch (e) {
      summary.failed++;
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      // The claim may or may not have happened; either way make it retry tomorrow, never immediately.
      await recordRadarBlocked(deps.db, radar.id, msg, addDays(deps.now(), RETRY_DAYS)).catch(() => {});
    }
  }
  return summary;
}
