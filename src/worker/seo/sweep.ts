import { monthRange } from "../care/reportFacts";
import { previousMonth } from "../care/reportSweep";
import { testClientSql } from "../clients/record";
import { logActivityOnce } from "../db/activity";
import { holdFreeSql } from "../db/holds";
import { liveProjectSql } from "../db/projects";
import { getProfile, listContent, listKeywords, rankChecksFor, upsertProfile, type RankCheck, type SeoProfile } from "../db/seo";
import { getSeoReportFor, insertSeoReport, type SeoReport } from "../db/seoReports";
import { getSettings } from "../db/settings";
import { getTemplate } from "../db/sops";
import { getTask } from "../db/tasks";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { localDay } from "../monitoring/rollup";
import { queueSeoReport } from "../queue/seoReport";
import { periodKey, zoneOf } from "../sop/cadence";
import { optionalJobBlock } from "../spend";
import { MAX_DRAFT_TRIES, draftTriesFor, ensureSlots, planFor as slotPlanFor } from "./content";
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
/**
 * A scheduled Worker on the Paid plan may make 10,000 subrequests an invocation, and every D1 call counts as one, and a Places call is two (the request and the row that records its price). What really bounds the run is its
 * wall time (a scheduled run may last about 15 minutes, and the Places calls are made one after another). So the run stops starting a client's Places work once this many calls are counted (a rank grid is 9 calls per active
 * keyword, 90 for ten, so a client with ten keywords costs 91 with its watch) and, separately, once `MAX_PLACES_WALL_MS` have passed. The rest of the clients wait for the next run.
 */
export const MAX_PLACES_CALLS_PER_RUN = 400;
/** The run starts no more Places work for any client this long after it began (reports, slots and ticks are never held by it): a call that is slow or throttled must not take the run's 15 minutes. */
export const MAX_PLACES_WALL_MS = 6 * 60_000;
/** The clock the wall-time guard reads, so a test can move it. */
export const seoClock = { now: (): number => Date.now() };
/** A month's rank pull is retried on a later day while some active keyword still has no usable check, but on at most this many distinct days of the month (the cost bound). */
export const MAX_PULL_DAYS_PER_MONTH = 4;
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
  /** The month's rank pull is due: somewhere to check from, something to check, no check taken today, an active keyword with no usable check this month, and fewer than `MAX_PULL_DAYS_PER_MONTH` days tried. */
  pull: boolean;
  /** Last month has no report (or one with no words job). */
  reportOpen: boolean;
  /** This month's checks (so far). */
  checks: RankCheck[];
  /** A usable rank check from this month exists now. */
  usable: boolean;
  /** The month has a check, a plan and active keywords, and fewer slot rows than the plan includes or a slot that is planned with no draft task (no Places call needed). */
  slotsDue: boolean;
  /** A usable check exists but 1.1 is not yet ticked on the month's SEO-1 task. */
  tickDue: boolean;
  /** The Places calls the watch and the pull would make, at most. */
  cost: number;
}

/** Whether the client's SEO-1 task of `current` is still open with its 1.1 step (the data pull) not ticked, and lines up with the template (the same test `tickSeo1` applies). */
async function tickPending(env: Env, businessId: string, current: string): Promise<boolean> {
  const tpl = await getTemplate(env.DB, SEO_1);
  const idx = tpl ? tpl.steps.findIndex((st) => st.key === "1.1") : -1;
  if (!tpl || idx < 0) return false;
  const ids = (await env.DB.prepare(`SELECT id FROM tasks WHERE business_id = ? AND cadence_key = ? AND period_key = ? AND is_step = 0`).bind(businessId, SEO_1, current).all<{ id: string }>()).results;
  for (const { id } of ids) {
    const task = await getTask(env.DB, id);
    if (task && task.status !== "done" && task.status !== "skipped" && task.checklist.length === tpl.steps.length && task.checklist[idx].text.startsWith(tpl.steps[idx].title) && !task.checklist[idx].done) return true;
  }
  return false;
}

async function planFor(env: Env, businessId: string, o: { today: string; monthFrom: string; period: string; current: string }): Promise<Plan | null> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) return null;
  const active = await listKeywords(env.DB, businessId, { activeOnly: true });
  const checks = await rankChecksFor(env.DB, businessId, { from: o.monthFrom });
  const report = await getSeoReportFor(env.DB, businessId, o.period);
  const usableKeywords = new Set(checks.filter((c) => isUsable(c.points)).map((c) => c.keywordId));
  const days = new Set(checks.map((c) => c.takenOn));
  const watch = !!profile.placeId && watchDue(profile.lastWatchOn, o.today);
  const pull = !!profile.placeId && profile.lat !== null && profile.lng !== null && active.length > 0 && !days.has(o.today)
    && active.some((k) => !usableKeywords.has(k.id)) && days.size < MAX_PULL_DAYS_PER_MONTH;
  const usable = usableKeywords.size > 0;
  let slotsDue = false;
  if (checks.length > 0 && active.length > 0) {
    const slotPlan = await slotPlanFor(env.DB, businessId);
    if (slotPlan) {
      // A slot left `planned` with no task (its draft task expired or was given up on fewer than `MAX_DRAFT_TRIES` times, or a crash came between making the row and queueing it) is due too: `ensureSlots` hands it to Claude again.
      const rows = await listContent(env.DB, { businessId, period: o.current });
      const tries = await draftTriesFor(env.DB, businessId);
      slotsDue = rows.length < slotPlan.content + slotPlan.gbpPosts || rows.some((i) => i.status === "planned" && i.claudeTaskId === null && (tries.get(i.id) ?? 0) < MAX_DRAFT_TRIES);
    }
  }
  return {
    profile, keywords: active.length, watch, pull, checks,
    reportOpen: !report || (report.status === "collecting" && !report.claudeTaskId),
    usable, slotsDue, tickDue: usable && (await tickPending(env, businessId, o.current)),
    cost: (watch ? 1 : 0) + (pull ? CALLS_PER_KEYWORD * active.length : 0),
  };
}

export interface SeoSweepResult { clients: number; watched: number; ranked: number; reports: number; blocked: boolean }

/**
 * The daily Local SEO sweep. For each candidate (a real client with an `active` profile, no billing hold and a live project carrying SEO-1) that has something to do, at most `MAX_CLIENTS_PER_RUN` of them, the one handled
 * longest ago first, each part in its own try/catch (a failure is logged and never stops the rest or the next client):
 * 1. the review watch, when the last one is more than `WATCH_EVERY_DAYS` booking-zone days old;
 * 2. the month's rank pull, when no check was taken today, some active keyword has no usable check this month and fewer than `MAX_PULL_DAYS_PER_MONTH` days of the month have a check (so a throttled first day is retried on later days);
 *    then, with no Places call and whoever made the month's first check (the sweep, the owner's rank check or the baseline): the month's content slots (SEO-1's period) once the month has a check and fewer slots than its plan,
 *    and the tick of 1.1 on the month's SEO-1 task once a usable check exists;
 * 3. last month's report, when it has none and a usable rank check from this month exists (so it follows the pull): the frozen facts, the row and Claude's job for the words. No Places call, so neither the budget nor the spend gate holds it.
 * Parts 1 and 2 call Places. They stop for everyone, with one logged line, once the places sub-cap or the total cap is reached (`blocked`), and the run counts its Places calls and starts no client's Places work that would take it
 * past `MAX_PLACES_CALLS_PER_RUN` (or once `MAX_PLACES_WALL_MS` have passed since the run began; a client's watch and pull are held back together, and so is every client after it, so the next run starts with it: a client held back is not touched and so stays first in line).
 * Returns `clients` (handled), `watched` (listings read), `ranked` (clients with at least one usable check made now), `reports` (made now) and `blocked` (Places work was held back by the spend gate).
 */
export async function sweepSeo(env: Env, now: Date): Promise<SeoSweepResult> {
  const tz = zoneOf(await getSettings(env.DB));
  const today = localDay(now.toISOString(), tz);
  const current = periodKey("monthly", now, tz);
  const period = previousMonth(now, tz);
  const monthFrom = monthRange(current, tz).fromDay;
  const out: SeoSweepResult = { clients: 0, watched: 0, ranked: 0, reports: 0, blocked: false };

  const startedAt = seoClock.now();
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
      plan = await planFor(env, businessId, { today, monthFrom, period, current });
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
      } else if (seoClock.now() - startedAt > MAX_PLACES_WALL_MS) {
        stopped = true;
        console.log("seo sweep: the run has used its time for Places work, the rest wait for the next run");
      } else go = true;
    }
    if (!go && !(plan.reportOpen && plan.usable) && !plan.slotsDue && !plan.tickDue) continue; // nothing this client can have done today
    out.clients++;

    let halted = false; // the watch found the client's Google place gone or changed: the client is paused, and nothing more is done for it today
    if (go && plan.watch) {
      used++;
      try {
        const watch = await watchReviews(env, businessId, now);
        if (watch.paused) halted = true;
        if (watch.snapshot) out.watched++;
        // Google shows at most five reviews, not always the newest: a review count that rose by more than the reviews we could read is said on the client's timeline, once for each watch.
        if (watch.unseen > 0) {
          await logActivityOnce(env.DB, businessId, "note", `Local SEO watch ${today}: the Google listing has ${watch.unseen} more ${watch.unseen === 1 ? "review" : "reviews"} than Google shows us. Check the profile.`);
        }
      } catch (e) {
        console.error("seo sweep: could not watch a client's reviews", msg(e));
      }
    }

    if (halted) continue;
    let pulled = false;
    if (go && plan.pull) {
      const calls = { n: 0 };
      try {
        const r = await runRankGrid(env, businessId, now, { calls });
        pulled = true;
        if (r.unmeasured < plan.keywords) out.ranked++;
      } catch (e) {
        console.error("seo sweep: could not pull a client's ranks", msg(e));
      } finally {
        used += calls.n;
      }
    }

    // The month's slots and the 1.1 tick need no Places call, so neither the budget nor the spend gate holds them, and they do not depend on this sweep having made the pull (the owner's rank check or the baseline may have): the slots
    // are made once the month has a check and fewer slots than its plan, or right after a pull; 1.1 is ticked whenever a usable check exists (a tick is never undone, so repeating it is harmless).
    let checks = plan.checks;
    try { if (pulled) checks = await rankChecksFor(env.DB, businessId, { from: monthFrom }); } catch (e) { console.error("seo sweep: could not read a client's checks", msg(e)); }
    const usable = checks.some((c) => isUsable(c.points));
    if (pulled || plan.slotsDue) {
      try { await ensureSlots(env, businessId, current, now); } catch (e) { console.error("seo sweep: could not plan a client's content", msg(e)); }
    }
    if (usable && (pulled || plan.tickDue)) await tickSeo1(env, businessId, current, ["1.1"], now);

    if (plan.reportOpen && usable) {
      try {
        if ((await begin(env, businessId, period, false, now, tz)).created) out.reports++;
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
