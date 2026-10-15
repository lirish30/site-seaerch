import type { Env } from "../env";
import { getSettings } from "../db/settings";
import { listDueSources, listUndiscovered } from "../db/jobs";
import { discoverSource, syncSource, type JobDeps } from "./sync";

// One tick is one batch of outbound fetches. 40 keeps it far under the Worker's subrequest limit even when discovery reads a careers page too.
export const JOB_WATCH_MAX_PER_TICK = 40, DISCOVER_PER_TICK = 15;

/** Real network, clock and an owner-identifying user agent; shared by the cron and the manual routes so boards see the same caller. */
export async function jobDeps(env: Env): Promise<JobDeps> {
  const s = await getSettings(env.DB);
  return { db: env.DB, fetch: (u, i) => fetch(u, i), now: () => new Date(), userAgent: `SiteSearchJobWatch/1.0 (+contact: ${s.contact_email || s.business_name || "owner"})` };
}

/** Polls the boards that are due, then spends what is left of the budget finding boards for scanned leads. */
export async function runJobWatch(deps: JobDeps, opts: { max?: number } = {}) {
  const max = opts.max ?? JOB_WATCH_MAX_PER_TICK;
  const summary = { synced: 0, discovered: 0, failed: 0 };
  const nowIso = deps.now().toISOString();
  const due = await listDueSources(deps.db, nowIso, max);
  for (const s of due) {
    try { (await syncSource(deps, s)).error ? summary.failed++ : summary.synced++; }
    catch (e) { summary.failed++; console.error("job sync failed", s.business_id, e); }
  }
  const room = max - due.length;
  if (room > 0) {
    for (const { id } of await listUndiscovered(deps.db, nowIso, Math.min(room, DISCOVER_PER_TICK))) {
      try { await discoverSource(deps, id); summary.discovered++; }
      catch (e) { summary.failed++; console.error("job discovery failed", id, e); }
    }
  }
  return summary;
}
