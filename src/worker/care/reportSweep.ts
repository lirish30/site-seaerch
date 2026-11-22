import { testClientSql } from "../clients/record";
import { getReportFor, insertReport, type CareReport } from "../db/careReports";
import { holdFreeSql } from "../db/holds";
import { CARE_SUBSCRIPTION_SQL } from "../db/monitoring";
import { liveProjectSql } from "../db/projects";
import { getSettings } from "../db/settings";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { queueReport } from "../queue/careReport";
import { periodKey, zoneOf } from "../sop/cadence";
import { previousMonth } from "../sop/months";
import { trafficWait } from "../traffic/pull";
import { buildFacts, monthRange } from "./reportFacts";
import { CARE_4, tickCare4 } from "./tasks";

// Starting each Care client's monthly report (Plan 13). On the first daily run of a month the client's CARE-4 task for the new month exists; from then on, until the client has a report, the sweep builds the
// report of the month before it (once the uptime rollup has covered at least part of that month): the frozen facts, a `care.report` job for Claude's summary, and the first ticks of the CARE-4 checklist. Nothing is sent here: the report waits for the owner's approval.

/** The most clients one daily run starts; the rest are picked up by the next run (a client with a report is no longer a candidate). */
const MAX_PER_RUN = 50;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** A refusal with a plain sentence the owner may read (a route answers it 409); anything else thrown is a real fault. */
export class CareReportRefused extends Error {
  constructor(message: string) { super(message); this.name = "CareReportRefused"; }
}

export { previousMonth } from "../sop/months";

/**
 * Makes the client's report of `period` if it has none, queues the summary and ticks 1.1 and 1.4 on the CARE-4 task of the current month. A report that exists is returned with `created: false`, and one left without
 * its summary job (a crash between the two writes) gets its job now; the facts are only built (PageSpeed included) when there is no report yet.
 */
async function begin(env: Env, businessId: string, period: string, test: boolean, now: Date, tz: string): Promise<{ report: CareReport; created: boolean }> {
  let report = await getReportFor(env.DB, businessId, period);
  let created = false;
  if (!report) {
    const facts = await buildFacts(env, businessId, period, now);
    ({ report, created } = await insertReport(env.DB, { businessId, period, token: newClientToken(), facts, test, now: now.toISOString() }));
  }
  if (report.status === "collecting" && !report.claudeTaskId) {
    await queueReport(env, report.id);
    report = (await getReportFor(env.DB, businessId, period)) ?? report;
  }
  await tickCare4(env, businessId, periodKey("monthly", now, tz), ["1.1", "1.4"], now);
  return { report, created };
}

/**
 * The real clients with live Care (a billing or late Care subscription) that have a CARE-4 task for the current month still to do on a live, real project, no billing hold and no report (or one with no summary job yet) for `period`,
 * at most the cap. The project's CARE-4 cadence must have been attached before `periodEnd` (the first instant after the reported month): a client whose Care began after that month has nothing to report on. One attached inside
 * the month still gets a (partial) first report. The uptime rollup must have written a day on or before the last day of the reported month (none at all means nothing to report on): the first sweeps after the rollup is deployed
 * would otherwise report a month it never measured as "no downtime" and "no updates".
 */
async function candidates(env: Env, current: string, period: string, range: { to: string; toDay: string }): Promise<string[]> {
  return (await env.DB.prepare(
    `SELECT t.business_id AS id FROM tasks t JOIN projects p ON p.id = t.project_id JOIN businesses b ON b.id = t.business_id
       JOIN project_cadences pc ON pc.project_id = t.project_id AND pc.template_key = t.cadence_key AND pc.created_at < ?
     WHERE t.cadence_key = ? AND t.period_key = ? AND t.is_step = 0 AND t.status NOT IN ('done', 'skipped')
       AND (SELECT MIN(day) FROM site_uptime_days) <= ?
       AND ${liveProjectSql("p")} AND p.test = 0 AND ${holdFreeSql("t")} AND NOT ${testClientSql("b")} AND ${CARE_SUBSCRIPTION_SQL("b")}
       AND NOT EXISTS (SELECT 1 FROM care_reports r WHERE r.business_id = t.business_id AND r.period = ? AND (r.status <> 'collecting' OR r.claude_task_id IS NOT NULL))
     GROUP BY t.business_id ORDER BY t.business_id LIMIT ?`,
  ).bind(range.to, CARE_4, current, range.toDay, period, MAX_PER_RUN).all<{ id: string }>()).results.map((r) => r.id);
}

/**
 * The daily start of the month's reports. `started` counts the reports made; `skipped` the clients that made none new (their facts failed, which is logged, or a report that had no summary job got one, or Google's numbers of the month are still being waited for). One client's failure never
 * stops the rest, and a failed client is tried again at the next daily run.
 */
export async function sweepReports(env: Env, now: Date): Promise<{ started: number; skipped: number }> {
  const tz = zoneOf(await getSettings(env.DB));
  const period = previousMonth(now, tz);
  let started = 0;
  let skipped = 0;
  const ids = await candidates(env, periodKey("monthly", now, tz), period, monthRange(period, tz));
  if (ids.length >= MAX_PER_RUN) console.log(`care reports: ${MAX_PER_RUN} clients started, the rest wait for the next run`);
  for (const businessId of ids) {
    try {
      // A report not yet made waits for Google's numbers of the month (until the 7th); one that exists is never waited for: its facts are frozen.
      if (!(await getReportFor(env.DB, businessId, period)) && await trafficWait(env, businessId, period, now)) { skipped++; continue; }
      if ((await begin(env, businessId, period, false, now, tz)).created) started++;
      else skipped++;
    } catch (e) {
      console.error("care reports: could not start a client's report", msg(e));
      skipped++;
    }
  }
  return { started, skipped };
}

/**
 * The owner starts the report of last month by hand, any day: any client with a live Care project (a project that carries the CARE-4 cadence), a rehearsal client and one on billing hold included.
 * `test` marks the report as a rehearsal. A report that exists is returned with `created: false`. Throws `CareReportRefused` for a client with no live Care project.
 */
export async function startReport(env: Env, businessId: string, o: { test: boolean; now: Date }): Promise<{ report: CareReport; created: boolean }> {
  const live = await env.DB.prepare(
    `SELECT 1 AS x FROM project_cadences c JOIN projects p ON p.id = c.project_id WHERE p.business_id = ? AND c.template_key = ? AND ${liveProjectSql("p")} LIMIT 1`,
  ).bind(businessId, CARE_4).first();
  if (!live) throw new CareReportRefused("This client has no live Care project, so there is no monthly report to start.");
  const tz = zoneOf(await getSettings(env.DB));
  return begin(env, businessId, previousMonth(o.now, tz), o.test, o.now, tz);
}
