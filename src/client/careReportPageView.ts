import type { PublicReport, PublicReportSite, PublicTraffic } from "../worker/care/reportPublic";

/** Pure helpers for the client's monthly report page (`/m/<token>`). Plain values in, plain text out: no DOM, no fetch, no clock. */

export type { PublicReport, PublicReportSite, PublicTraffic };
export { trafficView, type TrafficView } from "./trafficView";
type Edits = NonNullable<PublicReport["edits"]>;
type Renewal = PublicReport["renewals"][number];

/** The caption under a report's short video: it does not say how long the video is (it is as long as the report has numbers for). */
export const VIDEO_CAPTION = "A short summary";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 h 40 min", "1 h", "45 min", "0 min". A number that is not a length of time reads as "0 min". */
export function hours(minutes: number): string {
  const total = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const h = Math.floor(total / 60), m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A calendar date `YYYY-MM-DD` as "14 Nov" (the date as it is: no zone is applied), or null when it is not one. */
export function dayLabel(day: string | null): string | null {
  const m = day ? /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(day) : null;
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : null;
}

/** The uptime line of a site: "99.9% uptime over 29 days", else "monitored since 14 Nov", else null (the line is left out; an unmeasured month is never shown as 0% or 100%). */
export function uptimeLine(site: Pick<PublicReportSite, "uptimePercent" | "coveredDays" | "monitoredSince">): string | null {
  if (site.uptimePercent !== null) {
    const figure = `${Math.round(site.uptimePercent * 100) / 100}% uptime`;
    return site.coveredDays > 0 ? `${figure} over ${plural(site.coveredDays, "day", "days")}` : figure;
  }
  const since = dayLabel(site.monitoredSince);
  return since ? `monitored since ${since}` : null;
}

/** The edit hours as "30 min of 1 h". Over the allowance it is still the real figure ("1 h 40 min of 1 h"), never a percentage. Null when the client has no edit hours. */
export function editsLine(edits: Pick<Edits, "usedMinutes" | "allowanceMinutes"> | null): string | null {
  if (!edits) return null;
  return edits.allowanceMinutes > 0 ? `${hours(edits.usedMinutes)} of ${hours(edits.allowanceMinutes)}` : `${hours(edits.usedMinutes)} used`;
}

/** One renewal as a title and a date. */
export function renewalLine(r: Renewal): { title: string; date: string } {
  const date = dayLabel(r.on) ?? r.on;
  const of = (what: string) => (r.domain ? `${r.domain}: ${what}` : what[0].toUpperCase() + what.slice(1));
  switch (r.what) {
    case "domain": return { title: of("domain name"), date };
    case "certificate": return { title: of("security certificate"), date };
    case "subscription_term": return { title: "Your care plan term ends", date };
    default: return { title: "Annual renewal", date };
  }
}

/** The rows of one site's card, only what was measured. */
export function siteDetails(s: PublicReportSite): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const up = uptimeLine(s);
  if (up) rows.push({ label: "Uptime", value: up });
  // A month with no covered day was not measured: "no downtime" would be a claim about time nobody checked.
  if (s.incidents === 0) rows.push({ label: "Downtime", value: s.coveredDays > 0 ? "No downtime recorded" : "Not measured this month" });
  else {
    const times = s.incidents === 1 ? "Went down once" : `Went down ${s.incidents} times`;
    rows.push({ label: "Downtime", value: s.longestOutageMinutes !== null ? `${times}; the longest was about ${hours(s.longestOutageMinutes)}` : times });
  }
  // The update rows are for a site an update run covered; for any other the counts were not measured, and "none applied" would say they were.
  if (s.updatesTracked) {
    if (s.updatesApplied === 0 && s.updatesRolledBack === 0) rows.push({ label: "Updates", value: "None applied this month" });
    else {
      const undone = s.updatesRolledBack > 0 ? `, ${s.updatesRolledBack} undone because ${s.updatesRolledBack === 1 ? "it" : "they"} caused a problem` : "";
      rows.push({ label: "Updates", value: `${s.updatesApplied} applied${undone}` });
    }
  }
  if (s.backups > 0) rows.push({ label: "Backups", value: `${s.backups} taken` });
  if (s.speedScore !== null) rows.push({ label: "Mobile speed", value: `${s.speedScore} out of 100` });
  return rows;
}

/** A colour for a fact on the client's pages; the words always say the same, so colour is never the only signal. */
export type FactTone = "neutral" | "positive" | "warning" | "critical" | "info" | "signal";

/** How a site's row reads at a glance: good news green, a problem amber. Only from the words `siteDetails` already wrote. */
export function siteFactTone(row: { label: string; value: string }): FactTone {
  if (row.label === "Downtime") return /^No downtime/.test(row.value) ? "positive" : /^Went down/.test(row.value) ? "warning" : "neutral";
  if (row.label === "Uptime") return /^monitored/.test(row.value) ? "neutral" : "positive";
  if (row.label === "Updates") return /undone/.test(row.value) ? "warning" : "neutral";
  if (row.label === "Mobile speed") { const n = Number(row.value.split(" ")[0]); return n >= 90 ? "positive" : n >= 50 ? "neutral" : "warning"; }
  return "neutral";
}

/** The line and chips at the top of the report: what the month came to, only from what was measured. */
export function careGlance(p: Pick<PublicReport, "sites" | "edits" | "renewals">): { headline: string; chips: { text: string; tone: FactTone }[] } {
  const chips: { text: string; tone: FactTone }[] = [];
  const measured = p.sites.filter((s) => s.coveredDays > 0);
  const downs = p.sites.reduce((n, s) => n + s.incidents, 0);
  if (downs > 0) chips.push({ text: downs === 1 ? "Went down once" : `Went down ${downs} times`, tone: "warning" });
  else if (measured.length > 0) chips.push({ text: "No downtime", tone: "positive" });
  const tracked = p.sites.filter((s) => s.updatesTracked);
  const applied = tracked.reduce((n, s) => n + s.updatesApplied, 0);
  if (tracked.length > 0) chips.push({ text: applied === 0 ? "No updates needed" : `${applied} ${applied === 1 ? "update" : "updates"} applied`, tone: applied > 0 ? "info" : "neutral" });
  const backups = p.sites.reduce((n, s) => n + s.backups, 0);
  if (backups > 0) chips.push({ text: `${backups} ${backups === 1 ? "backup" : "backups"}`, tone: "neutral" });
  if (p.edits) chips.push({ text: `Edits ${editsLine(p.edits)}`, tone: p.edits.state === "over" ? "critical" : p.edits.state === "warn" ? "warning" : "neutral" });
  const ups = p.sites.filter((s) => s.uptimePercent !== null);
  let headline: string;
  if (p.sites.length === 0) headline = "Here is your month";
  else if (ups.length === p.sites.length) {
    const low = Math.min(...ups.map((s) => Math.round((s.uptimePercent ?? 0) * 100) / 100));
    headline = p.sites.length === 1 ? `Your site was up ${low}% of the time` : `Your sites were up at least ${low}% of the time`;
  } else headline = p.sites.length === 1 ? "Your site this month" : `Your ${p.sites.length} sites this month`;
  return { headline, chips };
}

/** "40 (last month 30)" as its figure and the comparison, so the figure can be shown large. A value without a comparison comes back whole. */
export function splitBeside(value: string): { figure: string; before: string | null } {
  const m = /^(.*?) \(last month (.*)\)$/.exec(value);
  return m ? { figure: m[1], before: `Last month ${m[2]}` } : { figure: value, before: null };
}
