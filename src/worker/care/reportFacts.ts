import { z } from "zod";
import { dayKey, wallToUtc } from "../booking/slots";
import { LIVE } from "../clients/record";
import { uptimeDays } from "../db/careReports";
import { monitoredSiteSql } from "../db/monitoring";
import { siteDomain } from "../db/businesses";
import { getSettings } from "../db/settings";
import { toSite, type Site, type SiteRow } from "../db/sites";
import type { Env } from "../env";
import { MIN_CHECKS_FOR_A_DAY, uptimeOf } from "../monitoring/rollup";
import { runPageSpeed } from "../pagespeed";
import { periodLabel, zoneOf } from "../sop/cadence";
import { editLedger } from "./ledger";
import { COLLATERAL_NOTE } from "./updateKind";

// The facts a client's monthly Care report is built from (Plan 13), frozen into the report row when it is made. Only what the app measured goes in: a number it could not measure is
// null or left out, never 0 or 100%. NOTHING a client site or the helper said in words goes in either: no plugin name or slug, no incident sentence, no backup file name, no ssh alias,
// no WordPress folder, no password-manager item, no access note. A month and a day are the owner's booking-zone ones, never UTC.

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Count = z.number().int().min(0).max(1_000_000);

export const SiteFacts = z.object({
  domain: z.string().min(1).max(253),
  /** The first day a day of checks was covered (at least MIN_CHECKS_FOR_A_DAY), or null when none was by the month's end. */
  monitoredSince: Day.nullable(),
  uptimePercent: z.number().min(0).max(100).nullable(),
  /** The days of the month the uptime figure is from. */
  coveredDays: z.number().int().min(0).max(31),
  incidents: Count,
  longestOutageMinutes: Count.nullable(),
  updatesApplied: Count,
  updatesRolledBack: Count,
  updatesFailed: Count,
  /** True when an update run of the site finished in the month, so the update numbers are measured. Missing (an older report) or false: nothing was measured, and the zeros are not shown or said as "none". */
  updatesTracked: z.boolean().optional(),
  backups: Count,
  speedScore: z.number().int().min(0).max(100).nullable(),
});
export type SiteFacts = z.infer<typeof SiteFacts>;

export const ReportFacts = z.object({
  version: z.literal(1),
  /** The month reported, `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /** `November 2026`. */
  label: z.string().min(1).max(40),
  /** The month's first instant in the booking zone, and the first instant after it (UTC ISO). */
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  clientName: z.string().max(200),
  sites: z.array(SiteFacts).max(100),
  edits: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    allowanceMinutes: Count,
    usedMinutes: Count,
    percent: z.number().int().min(0).nullable(),
    state: z.enum(["ok", "warn", "over"]),
    requestsDone: Count,
  }).nullable(),
  renewals: z.array(z.object({
    what: z.enum(["domain", "certificate", "subscription_term", "annual_renewal"]),
    domain: z.string().min(1).max(253).nullable(),
    on: Day,
  })).max(10),
  generatedAt: z.string().min(1).max(40),
});
export type ReportFacts = z.infer<typeof ReportFacts>;

/** A renewal is listed from today until this many days after it. */
const RENEWAL_DAYS = 60;
const MAX_RENEWALS = 10;
const SPEED_TIMEOUT_MS = 30_000;
/** PageSpeed is asked about this many sites at a time. */
const SPEED_AT_ONCE = 3;
const SUMMARY_MAX = 600;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The calendar date `n` days after the `YYYY-MM-DD` date `day`. */
function daysAfter(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The local month `period` (`YYYY-MM`) in `tz`: `from` is its first instant and `to` the first instant after it (both UTC ISO, so `finished_at >= from AND finished_at < to` is exact,
 * whatever the zone's offset or a DST change in the month); `fromDay` and `toDay` are its first and last calendar dates.
 */
export function monthRange(period: string, tz: string): { from: string; to: string; fromDay: string; toDay: string } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new RangeError(`not a month: ${period}`);
  const y = Number(m[1]), mo = Number(m[2]);
  // A local midnight that never happened (the clocks jumped over it) is the instant of the jump, which is the start of that day.
  const midnight = (yy: number, mm: number): string => new Date(wallToUtc(Date.UTC(yy, mm - 1, 1), 0, tz, true) as number).toISOString();
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: midnight(y, mo), to: mo === 12 ? midnight(y + 1, 1) : midnight(y, mo + 1), fromDay: `${m[1]}-${m[2]}-01`, toDay: `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * The mobile performance score PageSpeed gives a page, or null when there is no key or it could not be had for any reason (an error, a rate limit, no answer in time).
 * Kept alone, with its one call in `buildFacts`, so the plan's cut line (drop PageSpeed from the report) is deleting this function and that call.
 */
async function speedScore(env: Pick<Env, "PAGESPEED_API_KEY">, url: string): Promise<number | null> {
  if (!env.PAGESPEED_API_KEY) return null;
  try {
    const { facts } = await runPageSpeed(url, { apiKey: env.PAGESPEED_API_KEY, fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(SPEED_TIMEOUT_MS) }) });
    return Number.isInteger(facts.performanceScore) && facts.performanceScore >= 0 && facts.performanceScore <= 100 ? facts.performanceScore : null;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items`, at most `size` at a time, results in order. `fn` must not throw (a site's speed failure never reaches the others). Part of the speed cut line. */
async function inPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** One live monitored site's numbers for the month `r`. */
async function siteFacts(env: Env, site: Site, r: ReturnType<typeof monthRange>, now: Date): Promise<Omit<SiteFacts, "speedScore">> {
  const db = env.DB;
  const uptime = uptimeOf(await uptimeDays(db, site.id, r.fromDay, r.toDay));
  // The start date is the first covered day ever, not the first of the month, so a site watched since October does not read as watched since 1 November.
  const since = await db.prepare(`SELECT MIN(day) AS day FROM site_uptime_days WHERE site_id = ? AND checks >= ? AND day <= ?`).bind(site.id, MIN_CHECKS_FOR_A_DAY, r.toDay).first<{ day: string | null }>();

  // The incident's own words (`detail`) are never read.
  const down = (await db.prepare(`SELECT opened_at, closed_at FROM site_incidents WHERE site_id = ? AND kind = 'down' AND opened_at >= ? AND opened_at < ?`)
    .bind(site.id, r.from, r.to).all<{ opened_at: string; closed_at: string | null }>()).results;
  // An outage counts only the time inside the month and up to now: one that closed after the month end, or is still open, is cut there.
  const stop = Math.min(Date.parse(r.to), now.getTime());
  const outages = down.map((i) => Math.max(0, Math.min(Date.parse(i.closed_at ?? "") || stop, stop) - Date.parse(i.opened_at))).filter((ms) => Number.isFinite(ms));
  const longest = outages.length ? Math.max(1, Math.round(Math.max(...outages) / 60_000)) : null;

  // The runs of the month are those that FINISHED in it. What happened to each update is what the run recorded: the helper's per-update `steps` stored in the job's result, not the update's
  // status now (the next inventory read resets a failed or rolled-back update to available). A retried update counts its outcome in each run's own month; a skipped one counts nothing. An update the helper
  // put back only because ANOTHER one failed (the collateral note) is waiting again and caused nothing: it counts as neither rolled back nor failed.
  const counted = (await db.prepare(
    `SELECT json_extract(s.value, '$.outcome') AS outcome, COUNT(*) AS n
       FROM care_runs r JOIN helper_jobs j ON j.id = r.helper_job_id AND j.result IS NOT NULL JOIN json_each(j.result, '$.steps') s
      WHERE r.site_id = ? AND r.finished_at >= ? AND r.finished_at < ?
        AND NOT (json_extract(s.value, '$.outcome') = 'rolled_back' AND COALESCE(instr(json_extract(s.value, '$.note'), ?), 0) = 1) GROUP BY outcome`,
  ).bind(site.id, r.from, r.to, COLLATERAL_NOTE).all<{ outcome: string; n: number }>()).results;
  const nOf = (...outcomes: string[]) => counted.filter((c) => outcomes.includes(c.outcome)).reduce((n, c) => n + c.n, 0);
  const ran = await db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(backup_file IS NOT NULL AND backup_file <> ''), 0) AS backups FROM care_runs WHERE site_id = ? AND finished_at >= ? AND finished_at < ?`)
    .bind(site.id, r.from, r.to).first<{ runs: number; backups: number }>();
  const backups = ran?.backups ?? 0;

  return {
    domain: site.domain ?? siteDomain(site.url) ?? "this site",
    monitoredSince: since?.day ?? null, uptimePercent: uptime.percent, coveredDays: uptime.coveredDays,
    incidents: down.length, longestOutageMinutes: longest,
    updatesApplied: nOf("applied"), updatesRolledBack: nOf("rolled_back"), updatesFailed: nOf("failed", "rollback_failed"),
    updatesTracked: (ran?.runs ?? 0) > 0, backups,
  };
}

/** The domain, certificate and subscription-term dates from today up to RENEWAL_DAYS after it, soonest first, at most MAX_RENEWALS. */
async function renewalsOf(env: Env, businessId: string, sites: Site[], today: string): Promise<ReportFacts["renewals"]> {
  const last = daysAfter(today, RENEWAL_DAYS);
  const all: ReportFacts["renewals"] = [];
  const add = (what: ReportFacts["renewals"][number]["what"], domain: string | null, on: string | null) => {
    if (on && /^\d{4}-\d{2}-\d{2}$/.test(on) && on >= today && on <= last) all.push({ what, domain, on });
  };
  for (const s of sites) {
    const domain = s.domain ?? siteDomain(s.url) ?? "this site";
    add("domain", domain, s.domainExpiresOn);
    add("certificate", domain, s.certExpiresOn);
  }
  const terms = (await env.DB.prepare(`SELECT term_ends_on FROM subscriptions WHERE business_id = ? AND test = 0 AND status IN (${LIVE.map(() => "?").join(",")}) AND term_ends_on IS NOT NULL`)
    .bind(businessId, ...LIVE).all<{ term_ends_on: string }>()).results;
  for (const t of terms) add("subscription_term", null, t.term_ends_on);
  // There is no annual renewal date anywhere in the data (a subscription records its term end and first charge, not a billing interval), so none is made up: "annual_renewal" stays in the schema for when there is.
  const rank = { domain: 0, certificate: 1, subscription_term: 2, annual_renewal: 3 };
  return all.sort((a, b) => a.on.localeCompare(b.on) || rank[a.what] - rank[b.what] || (a.domain ?? "").localeCompare(b.domain ?? "")).slice(0, MAX_RENEWALS);
}

/**
 * The facts of the report of `period` (the month REPORTED, `YYYY-MM`) for a client, as of `now`. The sites are the client's live, real, monitored ones. The speed score is asked of PageSpeed
 * only when `o.speed !== false`, and any failure leaves it null. `edits` is null for a client with no live Care plan.
 */
export async function buildFacts(env: Env, businessId: string, period: string, now: Date, o: { speed?: boolean } = {}): Promise<ReportFacts> {
  const tz = zoneOf(await getSettings(env.DB));
  const range = monthRange(period, tz);
  const name = (await env.DB.prepare(`SELECT name FROM businesses WHERE id = ?`).bind(businessId).first<{ name: string }>())?.name ?? "";
  const sites = (await env.DB.prepare(
    `SELECT s.* FROM sites s JOIN businesses b ON b.id = s.business_id WHERE s.business_id = ? AND ${monitoredSiteSql("s", "b")} ORDER BY s.created_at, s.id`,
  ).bind(businessId).all<SiteRow>()).results.map(toSite);

  const speeds = await inPool(sites, SPEED_AT_ONCE, (s) => (o.speed !== false && s.url ? speedScore(env, s.url) : Promise.resolve(null)));
  const perSite: SiteFacts[] = [];
  for (const [i, site] of sites.entries()) perSite.push({ ...(await siteFacts(env, site, range, now)), speedScore: speeds[i] });

  const ledger = await editLedger(env, businessId, period, tz);
  const requestsDone = ledger
    ? (await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE business_id = ? AND edit_request = 1 AND status = 'done' AND done_at >= ? AND done_at < ?`)
      .bind(businessId, range.from, range.to).first<{ n: number }>())?.n ?? 0
    : 0;

  return ReportFacts.parse({
    version: 1, period, label: periodLabel("monthly", period), from: range.from, to: range.to, clientName: name.slice(0, 200), sites: perSite,
    edits: ledger ? { ...ledger, requestsDone } : null,
    renewals: await renewalsOf(env, businessId, sites, dayKey(now.getTime(), tz)),
    generatedAt: now.toISOString(),
  });
}

// --- the plain summary -----------------------------------------------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dayText = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const lengthText = (minutes: number) => (minutes < 120 ? plural(minutes, "minute", "minutes") : plural(Math.round(minutes / 60), "hour", "hours"));
/** More sites than this and the summary gives totals instead of a sentence per site. */
const SENTENCES_PER_SITE_UP_TO = 3;

/**
 * A summary written by code from the numbers alone, in fixed sentences: what Claude's draft falls back to. At most 600 characters (a sentence that would pass the limit is left out
 * whole), no address, and no word that came from a client's site. What was not measured is left out, never said as zero.
 */
export function plainSummary(f: ReportFacts): string {
  const lines: string[] = [`Care report for ${f.label}.`];
  const few = f.sites.length <= SENTENCES_PER_SITE_UP_TO;
  const firstOfMonth = `${f.period}-01`;

  const measured = f.sites.filter((s) => s.uptimePercent !== null);
  for (const s of few ? measured : measured.length ? [measured.reduce((low, s) => (s.uptimePercent! < low.uptimePercent! ? s : low))] : []) {
    const partial = s.monitoredSince !== null && s.monitoredSince > firstOfMonth ? ` (checked from ${dayText(s.monitoredSince)}, ${plural(s.coveredDays, "day", "days")})` : "";
    lines.push(`${s.domain} was up ${s.uptimePercent}% of the time${few ? "" : ", the lowest of the sites"}${partial}.`);
  }

  const downs = f.sites.filter((s) => s.incidents > 0);
  if (few) {
    for (const s of downs) {
      lines.push(s.incidents === 1
        ? `${s.domain} went down once${s.longestOutageMinutes !== null ? `, for about ${lengthText(s.longestOutageMinutes)}` : ""}.`
        : `${s.domain} went down ${s.incidents} times${s.longestOutageMinutes !== null ? `; the longest outage was about ${lengthText(s.longestOutageMinutes)}` : ""}.`);
    }
  } else if (downs.length) {
    const total = downs.reduce((n, s) => n + s.incidents, 0);
    lines.push(`Sites went down ${plural(total, "time", "times")} in total.`);
  }

  // The update sentence only speaks for the sites an update run covered: for the others "none applied" would be a zero the app never measured.
  const tracked = f.sites.filter((s) => s.updatesTracked === true);
  if (tracked.length) {
    const applied = tracked.reduce((n, s) => n + s.updatesApplied, 0), rolledBack = tracked.reduce((n, s) => n + s.updatesRolledBack, 0), failed = tracked.reduce((n, s) => n + s.updatesFailed, 0);
    if (applied + rolledBack + failed === 0) lines.push("No updates were applied this month.");
    else {
      const parts = [`${applied} ${applied === 1 ? "update was" : "updates were"} applied`];
      if (rolledBack) parts.push(`${rolledBack} ${rolledBack === 1 ? "was" : "were"} rolled back`);
      if (failed) parts.push(`${failed} could not be applied`);
      lines.push(`${parts.join(", ")}.`);
    }
    const backups = tracked.reduce((n, s) => n + s.backups, 0);
    if (backups) lines.push(`${backups} ${backups === 1 ? "backup was" : "backups were"} taken before updates.`);
  }

  const speeds = f.sites.filter((s) => s.speedScore !== null);
  if (speeds.length) lines.push(`Mobile speed score: ${speeds.slice(0, SENTENCES_PER_SITE_UP_TO).map((s) => `${s.domain} ${s.speedScore} out of 100`).join(", ")}.`);

  if (f.edits) {
    const used = f.edits.allowanceMinutes > 0 ? `${f.edits.usedMinutes} of ${f.edits.allowanceMinutes} edit minutes were used` : `${f.edits.usedMinutes} edit minutes were used`;
    lines.push(`${used} and ${f.edits.requestsDone} ${f.edits.requestsDone === 1 ? "edit request was" : "edit requests were"} done.`);
  }
  if (f.renewals.length) lines.push(`${f.renewals.length} ${f.renewals.length === 1 ? "renewal is" : "renewals are"} coming up in the next ${RENEWAL_DAYS} days.`);

  let text = lines[0];
  for (const line of lines.slice(1)) {
    if (`${text} ${line}`.length > SUMMARY_MAX) continue;
    text = `${text} ${line}`;
  }
  return text;
}
