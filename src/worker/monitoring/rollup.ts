import { dayKey } from "../booking/slots";
import { upsertUptimeDay } from "../db/careReports";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";

// The daily rollup of the raw uptime checks (Plan 13). The probe writes a check every five minutes (288 a day) and the daily sweep deletes checks older than CHECK_KEEP_DAYS,
// but a monthly report needs the whole month. So each local day's counts are copied into site_uptime_days, which nothing prunes.
// Days are the owner's booking-zone days, grouped here in code: the zone has DST, so a day is 23 or 25 hours twice a year and a SQL date() on UTC would split it wrongly.

/** A day counts towards a report's uptime only from this many checks on (half a normal day). A 23-hour day with its 276 checks is covered. */
export const MIN_CHECKS_FOR_A_DAY = 144;
/** The rollup recomputes today and this many local days before it, so a day is settled once its last check is in and a missed run is caught up. */
const RECOMPUTE_DAYS = 3;
/** How far back raw checks are read: the start of local day (today - RECOMPUTE_DAYS) is never more than 4 days and 14 hours before now, whatever the zone. */
const READ_BACK_MS = 5 * 86_400_000;

/** The `YYYY-MM-DD` the instant `iso` falls on in `tz`. */
export const localDay = (iso: string, tz: string): string => dayKey(Date.parse(iso), tz);

/** The calendar date `n` days before the `YYYY-MM-DD` date `day`; plain date arithmetic, so no zone or DST is involved. */
function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** A count that is certainly a non-negative integer. */
const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/**
 * Recomputes every site's local days from RECOMPUTE_DAYS before `now` through today from the raw checks and stores them (site_uptime_days), returning how many days it wrote.
 * Idempotent: a day is overwritten with its counts as they are now. A day with few checks is written too, with its true counts (uptimeOf decides what is covered).
 * Checks written with the same time (a cron run that fired twice) are one moment, ok when any of them was, as in recentOutcomes.
 */
export async function rollupUptime(env: Pick<Env, "DB">, now: Date): Promise<number> {
  const tz = zoneOf(await getSettings(env.DB));
  const fromDay = daysBefore(localDay(now.toISOString(), tz), RECOMPUTE_DAYS);
  const rows = (await env.DB.prepare(`SELECT site_id, checked_at, MAX(ok) AS ok FROM site_checks WHERE checked_at >= ? GROUP BY site_id, checked_at`)
    .bind(new Date(now.getTime() - READ_BACK_MS).toISOString()).all<{ site_id: string; checked_at: string; ok: number }>()).results;
  const perDay = new Map<string, { siteId: string; day: string; checks: number; okChecks: number }>();
  for (const r of rows) {
    if (Number.isNaN(Date.parse(r.checked_at))) continue;
    const day = localDay(r.checked_at, tz);
    if (day < fromDay) continue;
    const key = `${r.site_id}|${day}`;
    const d = perDay.get(key) ?? { siteId: r.site_id, day, checks: 0, okChecks: 0 };
    d.checks++;
    if (r.ok) d.okChecks++;
    perDay.set(key, d);
  }
  let written = 0;
  for (const d of perDay.values()) {
    const checks = count(d.checks);
    await upsertUptimeDay(env.DB, d.siteId, d.day, checks, Math.min(count(d.okChecks), checks));
    written++;
  }
  return written;
}

/**
 * The uptime of a set of days. Only days with at least MIN_CHECKS_FOR_A_DAY checks are covered; `percent` is one decimal of ok checks over all checks of the covered days,
 * and null (never 100) when none is covered. `firstDay` is the earliest covered day.
 */
export function uptimeOf(days: { day: string; checks: number; okChecks: number }[]): { percent: number | null; coveredDays: number; firstDay: string | null } {
  const covered = days.filter((d) => d.checks >= MIN_CHECKS_FOR_A_DAY);
  if (covered.length === 0) return { percent: null, coveredDays: 0, firstDay: null };
  const checks = covered.reduce((n, d) => n + d.checks, 0);
  const ok = covered.reduce((n, d) => n + d.okChecks, 0);
  return { percent: Math.round(((ok * 100) / checks) * 10) / 10, coveredDays: covered.length, firstDay: covered.map((d) => d.day).sort()[0] };
}
