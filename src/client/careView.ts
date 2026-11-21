import type { HealthBand } from "../worker/clients/health";
import type { CareRow, IncidentView, SiteMonitoringView } from "../worker/monitoring/fleet";
import { FALLBACK_ZONE } from "../worker/sop/cadence";

/** The view-model of the Care board and the client's Care panel: pure functions, so the pages only lay text out. Worker types are imported as types only. */

/** "Health 82", or "Health 82 · no checks yet" while there is nothing behind the uptime part of the score. */
export function healthLabel(h: { score: number; band: HealthBand; hasData: boolean }): string {
  return `Health ${h.score}${h.hasData ? "" : " · no checks yet"}`;
}

/** The colour family of a band: good is ok, watch is warn, at risk is bad. */
export function bandTone(b: HealthBand): "ok" | "warn" | "bad" {
  return b === "good" ? "ok" : b === "watch" ? "warn" : "bad";
}

/** "99.8%" (one decimal, none when whole), or "No checks yet": a site with no checks is unknown, never 0%. */
export function formatUptime(p: number | null): string {
  if (p === null) return "No checks yet";
  const r = Math.round(p * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "47 minutes", "3 hours 5 minutes", "1 day 2 hours", "less than a minute". */
function duration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "less than a minute";
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
  if (hours > 0) return m > 0 ? `${plural(hours, "hour")} ${plural(m, "minute")}` : plural(hours, "hour");
  return plural(m, "minute");
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Nov 21, 11:59 AM" in the given zone (the owner's booking zone); a zone Intl does not know falls back to Los Angeles. */
function whenIn(iso: string, zone: string): string {
  const fmt = (timeZone: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  try { return fmt(zone); } catch { return fmt(FALLBACK_ZONE); }
}

/**
 * One incident as a plain line. An open outage: "Down for 47 minutes: HTTP 503". A closed one: "Was down 47 minutes, back at Nov 21, 11:59 AM" (the time in `zone`).
 * A domain incident shows its sentence as the server worded it ("Domain expires in 12 days"); the server has already recomputed it, so nothing is counted here.
 */
export function incidentLine(i: IncidentView, now: Date, zone: string = FALLBACK_ZONE): string {
  if (i.kind === "domain_expiring") return capital(i.detail);
  if (i.closedAt !== null) {
    const away = new Date(i.closedAt).getTime() - new Date(i.openedAt).getTime();
    const dur = duration(away);
    return `Was down ${dur === "less than a minute" ? "for less than a minute" : dur}, back at ${whenIn(i.closedAt, zone)}`;
  }
  return `Down for ${duration(now.getTime() - new Date(i.openedAt).getTime())}: ${i.detail}`;
}

/** The state of one site in a word or two: Up, Slow, Down, Not checked yet, Can't be monitored or Monitoring off. */
export function siteStateLabel(s: SiteMonitoringView): string {
  if (!s.monitorable) return "Can't be monitored";
  if (!s.monitored) return "Monitoring off";
  if (s.up === null) return "Not checked yet";
  if (!s.up) return "Down";
  return s.slow ? "Slow" : "Up";
}

/** Worst score first, equal scores by name (case ignored). A new list; the one given is not changed, and equal rows keep their order. */
export function sortCare(rows: CareRow[]): CareRow[] {
  return [...rows].sort((a, b) => a.health.score - b.health.score || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
