import type { Env } from "../env";
import { getSettings } from "../db/settings";
import { getCareerSource, listDueSources, listUndiscovered, saveCareerSource } from "../db/jobs";
import type { CareerSource } from "../types";
import { discoverSource, RETRY_HOURS, syncSource, type JobDeps } from "./sync";

// 40 boards or leads per tick is ~55 outbound fetches worst case (discovery can read a careers page and a board): over the free plan's 50 subrequests, far under the paid plan's 1000, which this assumes.
export const JOB_WATCH_MAX_PER_TICK = 40, DISCOVER_PER_TICK = 15;

/** Real network, clock and an owner-identifying user agent; shared by the cron and the manual routes so boards see the same caller. */
export async function jobDeps(env: Env): Promise<JobDeps> {
  const s = await getSettings(env.DB);
  return { db: env.DB, fetch: (u, i) => fetch(u, i), now: () => new Date(), userAgent: `SiteSearchJobWatch/1.0 (+contact: ${s.contact_email || s.business_name || "owner"})` };
}

/** A lead that throws would sit at the head of its queue every tick and starve the rest, so push it out and say why; never throws itself, D1 may be what failed. */
async function reschedule(deps: JobDeps, id: string, known: CareerSource | null, e: unknown) {
  try {
    const cur = known ?? await getCareerSource(deps.db, id), now = deps.now();
    await saveCareerSource(deps.db, { business_id: id, status: cur?.status ?? "error", ats: cur?.ats, token: cur?.token, careers_url: cur?.careers_url, checked_at: now.toISOString(),
      last_ok_at: cur?.last_ok_at, next_check_at: new Date(now.getTime() + RETRY_HOURS * 3_600_000).toISOString(), empty_streak: cur?.empty_streak,
      last_error: String((e as Error)?.message ?? e).slice(0, 300) });
  } catch (e2) { console.error("job reschedule failed", id, e2); }
}

/** Polls the boards that are due, then spends what is left of the budget finding boards for scanned leads. */
export async function runJobWatch(deps: JobDeps, opts: { max?: number } = {}) {
  const max = opts.max ?? JOB_WATCH_MAX_PER_TICK;
  const summary = { synced: 0, discovered: 0, failed: 0 };
  const nowIso = deps.now().toISOString();
  const due = await listDueSources(deps.db, nowIso, max);
  for (const s of due) {
    try { (await syncSource(deps, s)).error ? summary.failed++ : summary.synced++; }
    catch (e) { summary.failed++; console.error("job sync failed", s.business_id, e); await reschedule(deps, s.business_id, s, e); }
  }
  const room = max - due.length;
  if (room > 0) {
    for (const { id } of await listUndiscovered(deps.db, nowIso, Math.min(room, DISCOVER_PER_TICK))) {
      try { await discoverSource(deps, id); summary.discovered++; }
      catch (e) { summary.failed++; console.error("job discovery failed", id, e); await reschedule(deps, id, null, e); }
    }
  }
  return summary;
}
