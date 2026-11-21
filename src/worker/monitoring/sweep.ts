import { closeUnmonitoredIncidents, monitoredSites, pruneChecks } from "../db/monitoring";
import type { Site } from "../db/sites";
import type { Env } from "../env";
import { recordDomainExpiry, recordProbe } from "./incidents";
import { ERROR_TEXT, monitorableUrl, PROBE_TIMEOUT_MS, probeSite, type ProbeResult } from "./probe";
import { fetchDomainExpiry } from "./rdap";

// The Care sweeps the existing crons run: the uptime probe every five minutes and the domain-expiry lookup once a day.
// They send nothing to anyone and create no task, approval or mail; the incidents and the activity line are the whole output (see incidents.ts).
// Neither sweep throws: one site's failure never stops the others, and a database failure ends the sweep with what it had done.

/** How many candidates a tick reads per site it may probe, so a run of sites with unusable addresses (never checked, so first in line every tick) cannot starve the valid ones behind them. */
const SCAN_FACTOR = 5;
/** The most sites one five-minute tick probes. The ones checked longest ago come first (monitoredSites), so every site gets its turn. */
export const MAX_PER_TICK = 40;
/** Sites probed at once. A chunk takes as long as its slowest site (10 s at most), so a tick of 40 stays under a minute. */
export const CONCURRENCY = 5;
/** Checks older than this are deleted by the daily sweep. */
export const CHECK_KEEP_DAYS = 35;
/** A domain is looked up again once it has gone this long without one. */
export const DOMAIN_RECHECK_DAYS = 7;

const DAY_MS = 86_400_000;
/** More sites than one daily run will look up (the registry call is the slow part); the rest wait for the next day. */
const MAX_DOMAINS_PER_RUN = 500;

/** The one seam tests replace: the fetch the sweeps use for sites and for the registry. Looked up when called, never captured at import. */
export const monitoringDeps: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export interface UptimeSweepResult { probed: number; failed: number; skipped: number; opened: number; closed: number }
export interface DomainSweepResult { checked: number; opened: number; closed: number; pruned: number }

const failure = (error: string, ms: number): ProbeResult => ({ ok: false, status: null, ms, error, slow: false });

/**
 * One probe that cannot throw and cannot hang. probeSite has its own 10 s abort; the extra cap is only for a fetch that ignores the signal,
 * so one such site can never hold up the sweep. A probe that throws is a failed check with the fixed "could not connect" phrase, never the thrown message.
 */
async function probeOne(url: string): Promise<ProbeResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve(failure(ERROR_TEXT.timeout, Date.now() - started)), PROBE_TIMEOUT_MS + 1_000);
  });
  try {
    return await Promise.race([probeSite(url, (input, init) => monitoringDeps.fetch(input, init), Date.now), cap]);
  } catch {
    return failure(ERROR_TEXT.connect, Date.now() - started);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` over `items` CONCURRENCY at a time; `fn` must not throw. */
async function inChunks<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
}

/** Probes up to MAX_PER_TICK monitored sites and records each result. A site whose address is not monitorable (monitorableUrl) is counted in `skipped` and never fetched, and does not use up a place in the tick. */
export async function sweepUptime(env: Env, now: Date): Promise<UptimeSweepResult> {
  const out: UptimeSweepResult = { probed: 0, failed: 0, skipped: 0, opened: 0, closed: 0 };
  // An incident of a site that is no longer watched (Care ended, switch off, address cleared, archived, marked test) would otherwise stay open for ever. Closed silently, in one statement.
  try {
    await closeUnmonitoredIncidents(env.DB, now.toISOString());
  } catch (e) {
    console.error("uptime: could not close the incidents of unmonitored sites", e);
  }
  try {
    // Read more than a tick can probe and keep the first MAX_PER_TICK valid ones. A site whose address is not monitorable gets no check row (a failed check could open an incident).
    const sites = await monitoredSites(env.DB, MAX_PER_TICK * SCAN_FACTOR);
    const todo: { site: Site; url: string }[] = [];
    for (const site of sites) {
      if (todo.length >= MAX_PER_TICK) break;
      const u = monitorableUrl(site.url);
      if (u.ok) todo.push({ site, url: u.url });
      else out.skipped++;
    }
    await inChunks(todo, async ({ site, url }) => {
      try {
        const result = await probeOne(url);
        const t = await recordProbe(env, site, result, now);
        out.probed++;
        if (!result.ok) out.failed++;
        if (t.opened) out.opened++;
        if (t.closed) out.closed++;
      } catch (e) {
        console.error("uptime: could not record a check", e);
      }
    });
  } catch (e) {
    console.error("uptime sweep failed", e);
  }
  return out;
}

/** Looks up the expiry of each monitored site's domain that has not been looked up for DOMAIN_RECHECK_DAYS, then deletes checks older than CHECK_KEEP_DAYS. */
export async function sweepDomains(env: Env, now: Date): Promise<DomainSweepResult> {
  const out: DomainSweepResult = { checked: 0, opened: 0, closed: 0, pruned: 0 };
  try {
    const staleBefore = now.getTime() - DOMAIN_RECHECK_DAYS * DAY_MS;
    const due = (await monitoredSites(env.DB, MAX_DOMAINS_PER_RUN)).filter((s) => {
      if (!s.domain) return false;
      const at = s.domainCheckedAt ? Date.parse(s.domainCheckedAt) : NaN;
      return Number.isNaN(at) || at < staleBefore;
    });
    await inChunks(due, async (site) => {
      try {
        // A lookup that failed (rate limit, server error, silence) stamps nothing, so the site is asked again at the next daily run. A registry that answered with no date stamps only
        // the lookup time: the last known date and the incidents stay as they were. `checked` counts the lookups made, failed ones included.
        const lookup = await fetchDomainExpiry(site.domain!, (input, init) => monitoringDeps.fetch(input, init));
        out.checked++;
        if (lookup.kind === "failed") return;
        const t = await recordDomainExpiry(env, site, lookup.kind === "found" ? lookup.expiresOn : null, now);
        if (t.opened) out.opened++;
        if (t.closed) out.closed++;
      } catch (e) {
        console.error("domain expiry: could not record a lookup", e);
      }
    });
  } catch (e) {
    console.error("domain sweep failed", e);
  }
  try {
    out.pruned = await pruneChecks(env.DB, new Date(now.getTime() - CHECK_KEEP_DAYS * DAY_MS).toISOString());
  } catch (e) {
    console.error("check prune failed", e);
  }
  return out;
}
