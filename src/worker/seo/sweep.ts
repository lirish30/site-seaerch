import { monthRange } from "../care/reportFacts";
import { previousMonth } from "../care/reportSweep";
import { testClientSql } from "../clients/record";
import { holdFreeSql } from "../db/holds";
import { liveProjectSql } from "../db/projects";
import { getProfile, listKeywords, rankChecksFor, upsertProfile, type SeoProfile } from "../db/seo";
import { getSeoReportFor, insertSeoReport, type SeoReport } from "../db/seoReports";
import { getSettings } from "../db/settings";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { localDay } from "../monitoring/rollup";
import { queueSeoReport } from "../queue/seoReport";
import { periodKey, zoneOf } from "../sop/cadence";
import { optionalJobBlock } from "../spend";
import { ensureSlots } from "./content";
import { isUsable, runRankGrid } from "./grid";
import { buildSeoFacts } from "./reportFacts";
import { watchReviews } from "./reviews";
import { SEO_1, tickSeo1 } from "./tasks";

// The daily Local SEO sweep (Plan 14): for each live Local SEO client, the review watch, the month's rank pull (with the month's content slots and the SEO-1 tick) and the start of last month's report.
// Nothing is sent or published here: the report waits for Claude's words and then for the owner's approval.

/** A client's reviews are watched again once the last watch is more than this many booking-zone days old. */
export const WATCH_EVERY_DAYS = 6;
/** The most clients one daily run handles; the rest are picked up by the next run, the one handled longest ago first. */
export const MAX_CLIENTS_PER_RUN = 25;
/** A Worker invocation may make about 1000 subrequests. A rank grid is up to 9 Places calls per active keyword (90 for ten), so the run stops starting Places work once this many are counted (the rest of the 1000 is for the database and the queue). */
export const MAX_PLACES_CALLS_PER_RUN = 700;
const CALLS_PER_KEYWORD = 9;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** A refusal with a plain sentence the owner may read (a route answers it 409); anything else thrown is a real fault. */
export class SeoReportRefused extends Error {
  constructor(message: string) { super(message); this.name = "SeoReportRefused"; }
}

const dayNumber = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};
const nextDay = (day: string): string => new Date((dayNumber(day) + 1) * 86_400_000).toISOString().slice(0, 10);

/** Whether the reviews of a client last watched on `last` are due on `today`: never watched, or more than `WATCH_EVERY_DAYS` days ago. */
const watchDue = (last: string | null, today: string): boolean => !last || !/^\d{4}-\d{2}-\d{2}$/.test(last) || dayNumber(today) - dayNumber(last) > WATCH_EVERY_DAYS;

/**
 * Makes the client's report of `period` if it has none, and queues Claude's words for it (a report left without its job by a crash between the two writes gets its job now). The facts are only built when there is no
 * report yet, and are frozen into it, so a report is refused (`SeoReportRefused`) until the month's usable rank check exists: one taken on or after the 1st of the month after `period`, with enough points measured.
 * A report that exists is returned with `created: false`.
 */
async function begin(env: Env, businessId: string, period: string, test: boolean, now: Date, tz: string): Promise<{ report: SeoReport; created: boolean }> {
  let report = await getSeoReportFor(env.DB, businessId, period);
  let created = false;
  if (!report) {
    const after = nextDay(monthRange(period, tz).toDay);
    if (!(await rankChecksFor(env.DB, businessId, { from: after })).some((c) => isUsable(c.points))) {
      throw new SeoReportRefused("There is no usable rank check from after that month yet, so there is nothing to report on. Run the rank check first.");
    }
    const facts = await buildSeoFacts(env, businessId, period, now);
    ({ report, created } = await insertSeoReport(env.DB, { businessId, period, token: newClientToken(), facts, test, now: now.toISOString() }));
  }
  if (report.status === "collecting" && !report.claudeTaskId) {
    await queueSeoReport(env, report.id);
    report = (await getSeoReportFor(env.DB, businessId, period)) ?? report;
  }
  return { report, created };
}

/**
 * Starts the report of `period` (`YYYY-MM`, the month reported) for a client by hand or from the sweep, any client: a rehearsal client and one on billing hold included. `test` marks the report as a rehearsal.
 * No Places call is made. Throws `SeoReportRefused` when there is no usable rank check from after that month.
 */
export async function startSeoReport(env: Env, businessId: string, period: string, o: { test: boolean; now: Date }): Promise<{ report: SeoReport; created: boolean }> {
  return begin(env, businessId, period, o.test, o.now, zoneOf(await getSettings(env.DB)));
}

/** The real clients with an active profile, no billing hold and a live, real project carrying the monthly SEO-1 cadence, least recently handled first (a handled client's profile is touched, so it moves to the back). */
async function candidates(env: Env): Promise<string[]> {
  return (await env.DB.prepare(
    `SELECT sp.business_id AS id FROM seo_profiles sp JOIN businesses b ON b.id = sp.business_id
     WHERE sp.status = 'active' AND NOT ${testClientSql("b")} AND ${holdFreeSql("sp")}
       AND EXISTS (SELECT 1 FROM project_cadences c JOIN projects p ON p.id = c.project_id WHERE p.business_id = sp.business_id AND c.template_key = ? AND p.test = 0 AND ${liveProjectSql("p")})
     ORDER BY sp.updated_at, sp.created_at, sp.rowid`,
  ).bind(SEO_1).all<{ id: string }>()).results.map((r) => r.id);
}

interface Plan {
  profile: SeoProfile;
  keywords: number;
  /** The listing's reviews are due, and there is a Google place to read. */
  watch: boolean;
  /** The month has no rank check yet, and there is somewhere to check from and something to check. */
  pull: boolean;
  /** Last month has no report (or one with no words job). */
  reportOpen: boolean;
  /** A usable rank check from this month exists now. */
  usable: boolean;
  /** The Places calls the watch and the pull would make, at most. */
  cost: number;
}

async function planFor(env: Env, businessId: string, o: { today: string; monthFrom: string; period: string }): Promise<Plan | null> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) return null;
  const keywords = (await listKeywords(env.DB, businessId, { activeOnly: true })).length;
  const checks = await rankChecksFor(env.DB, businessId, { from: o.monthFrom });
  const report = await getSeoReportFor(env.DB, businessId, o.period);
  const watch = !!profile.placeId && watchDue(profile.lastWatchOn, o.today);
  const pull = !!profile.placeId && profile.lat !== null && profile.lng !== null && keywords > 0 && checks.length === 0;
  return {
    profile, keywords, watch, pull,
    reportOpen: !report || (report.status === "collecting" && !report.claudeTaskId),
    usable: checks.some((c) => isUsable(c.points)),
    cost: (watch ? 1 : 0) + (pull ? CALLS_PER_KEYWORD * keywords : 0),
  };
}

export interface SeoSweepResult { clients: number; watched: number; ranked: number; reports: number; blocked: boolean }

/**
 * The daily Local SEO sweep. For each candidate (a real client with an `active` profile, no billing hold and a live project carrying SEO-1) that has something to do, at most `MAX_CLIENTS_PER_RUN` of them, the one handled
 * longest ago first, each part in its own try/catch (a failure is logged and never stops the rest or the next client):
 * 1. the review watch, when the last one is more than `WATCH_EVERY_DAYS` booking-zone days old;
 * 2. the month's rank pull, when there is no rank check yet this month: the grid, the month's content slots (SEO-1's period) and the tick of 1.1 on the month's SEO-1 task;
 * 3. last month's report, when it has none and a usable rank check from this month exists (so it follows the pull): the frozen facts, the row and Claude's job for the words. No Places call, so neither the budget nor the spend gate holds it.
 * Parts 1 and 2 call Places. They stop for everyone, with one logged line, once the places sub-cap or the total cap is reached (`blocked`), and the run counts its Places calls and starts no client's Places work that would take it
 * past `MAX_PLACES_CALLS_PER_RUN` (a client's watch and pull are held back together, and so is every client after it, so the next run starts with it: a client held back is not touched and so stays first in line).
 * Returns `clients` (handled), `watched` (listings read), `ranked` (clients with at least one usable check made now), `reports` (made now) and `blocked` (Places work was held back by the spend gate).
 */
export async function sweepSeo(env: Env, now: Date): Promise<SeoSweepResult> {
  const tz = zoneOf(await getSettings(env.DB));
  const today = localDay(now.toISOString(), tz);
  const current = periodKey("monthly", now, tz);
  const period = previousMonth(now, tz);
  const monthFrom = monthRange(current, tz).fromDay;
  const out: SeoSweepResult = { clients: 0, watched: 0, ranked: 0, reports: 0, blocked: false };

  let used = 0;
  let stopped = false; // the run's Places budget is spent
  let gate: "unknown" | "open" | "blocked" = "unknown";
  let gateAt = 0;
  let keyWarned = false;

  /** Whether Places work may start: the key is set and the spend caps allow it. Looked up when first needed and again after Places calls were made, so a cap reached part way through stops the rest. */
  const placesOpen = async (): Promise<boolean> => {
    if (!env.GOOGLE_PLACES_API_KEY) {
      if (!keyWarned) { keyWarned = true; console.error("seo sweep: the Places key is not set, so the watch and the rank pulls are skipped"); }
      return false;
    }
    if (gate === "blocked") return false;
    if (gate === "unknown" || used > gateAt) {
      gateAt = used;
      gate = (await optionalJobBlock(env.DB, now, ["places"])) === null ? "open" : "blocked";
      if (gate === "blocked") {
        out.blocked = true;
        console.error("seo sweep: the Places spend cap is reached, so the watch and the rank pulls wait");
      }
    }
    return gate === "open";
  };

  for (const businessId of await candidates(env)) {
    if (out.clients >= MAX_CLIENTS_PER_RUN) break;
    let plan: Plan | null;
    try {
      plan = await planFor(env, businessId, { today, monthFrom, period });
    } catch (e) {
      console.error("seo sweep: could not look at a client", msg(e));
      continue;
    }
    if (!plan) continue;

    // Whether this client's Places work may start: all of it fits in what is left of the run's budget, or none of it starts.
    const wants = plan.watch || plan.pull;
    let go = false;
    if (wants && !stopped && (await placesOpen())) {
      if (used + plan.cost > MAX_PLACES_CALLS_PER_RUN) {
        stopped = true;
        console.log("seo sweep: the Places budget for this run is used, the rest wait for the next run");
      } else go = true;
    }
    if (!go && !(plan.reportOpen && plan.usable)) continue; // nothing this client can have done today
    out.clients++;

    if (go && plan.watch) {
      used++;
      try {
        if ((await watchReviews(env, businessId, now)).snapshot) out.watched++;
      } catch (e) {
        console.error("seo sweep: could not watch a client's reviews", msg(e));
      }
    }

    let pulled = false;
    if (go && plan.pull) {
      const calls = { n: 0 };
      try {
        const r = await runRankGrid(env, businessId, now, { calls });
        pulled = true;
        if (r.unmeasured < plan.keywords) out.ranked++;
        await ensureSlots(env, businessId, current, now);
        await tickSeo1(env, businessId, current, ["1.1"], now);
      } catch (e) {
        console.error("seo sweep: could not pull a client's ranks", msg(e));
      } finally {
        used += calls.n;
      }
    }

    if (plan.reportOpen) {
      try {
        const usable = pulled ? (await rankChecksFor(env.DB, businessId, { from: monthFrom })).some((c) => isUsable(c.points)) : plan.usable;
        if (usable && (await begin(env, businessId, period, false, now, tz)).created) out.reports++;
      } catch (e) {
        if (!(e instanceof SeoReportRefused)) console.error("seo sweep: could not start a client's report", msg(e));
      }
    }

    // A client handled moves to the back of the line, whatever happened (a client that fails every day must not keep the front); one whose Places work was held back is not touched, so it stays first.
    if (!wants || go) {
      try { await upsertProfile(env.DB, businessId, {}, now.toISOString()); } catch (e) { console.error("seo sweep: could not note a client as handled", msg(e)); }
    }
  }
  return out;
}
