import { dayKey } from "../booking/slots";
import { getReportByToken, recordView } from "../db/careReports";
import { getSettings } from "../db/settings";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { ReportFacts } from "./reportFacts";

// What a client sees at `/m/<token>` (Plan 13): the monthly report, field by field. Nothing is spread from the stored facts and nothing is added to them here, so a field that is not
// listed in `PublicReport` can never reach a client: no id, no approval or task id, no raw facts, no alias, WordPress folder, backup or vault name, no token.

export interface PublicReportSite {
  domain: string;
  uptimePercent: number | null;
  coveredDays: number;
  monitoredSince: string | null;
  incidents: number;
  longestOutageMinutes: number | null;
  updatesApplied: number;
  updatesRolledBack: number;
  /** False when no update run covered the site that month: its update numbers were not measured, and the page says nothing about them. */
  updatesTracked: boolean;
  backups: number;
  speedScore: number | null;
}

/** What Google counted, as the page shows it. A block is left out when it was not measured; queries and page paths are plain strings (the page puts them in as text). */
export interface PublicTraffic {
  search?: {
    clicks: number; impressions: number; position: number | null; previousClicks: number | null; previousImpressions: number | null;
    queries: { query: string; clicks: number; impressions: number }[];
    pages: { path: string; clicks: number }[];
  };
  visits?: { sessions: number; users: number; organic: number; previousSessions: number | null; previousOrganic: number | null };
}

export interface PublicReport {
  clientName: string;
  /** `November 2026`. */
  label: string;
  summary: string;
  recommendation: string;
  sites: PublicReportSite[];
  edits: { usedMinutes: number; allowanceMinutes: number; state: "ok" | "warn" | "over"; requestsDone: number } | null;
  renewals: { what: "domain" | "certificate" | "subscription_term" | "annual_renewal"; domain: string | null; on: string }[];
  /** Absent when the report has no search or visit figures (older reports, or nothing linked). */
  traffic?: PublicTraffic;
  /** The day the report was sent, `YYYY-MM-DD` in the booking zone. */
  sentOn: string;
}

/** The traffic block of the page, field by field, or undefined when the report has neither a search nor a visits block. */
function publicTraffic(t: ReportFacts["traffic"]): PublicTraffic | undefined {
  if (!t || (!t.search && !t.visits)) return undefined;
  const out: PublicTraffic = {};
  if (t.search) {
    const s = t.search;
    out.search = {
      clicks: s.clicks, impressions: s.impressions, position: s.position, previousClicks: s.previousClicks, previousImpressions: s.previousImpressions,
      queries: s.queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions })), pages: s.pages.map((p) => ({ path: p.path, clicks: p.clicks })),
    };
  }
  if (t.visits) {
    const v = t.visits;
    out.visits = { sessions: v.sessions, users: v.users, organic: v.organic, previousSessions: v.previousSessions, previousOrganic: v.previousOrganic };
  }
  return out;
}

/**
 * The report behind a link, or null. Null is one answer for a malformed token (never looked up), an unknown one, and every report that is not `sent` (collecting, ready, revoked,
 * cancelled), so the caller cannot tell them apart. A view is counted only on a `sent` report, and only when the page can be shown, and not when `o.countView` is false (the owner opening the link themselves).
 */
export async function publicReport(env: Pick<Env, "DB">, token: string, now: Date, o: { countView?: boolean } = {}): Promise<PublicReport | null> {
  if (!isClientToken(token)) return null;
  const report = await getReportByToken(env.DB, token);
  if (!report || report.status !== "sent") return null;
  const parsed = ReportFacts.safeParse(report.facts);
  if (!parsed.success) return null;
  const f = parsed.data;

  const tz = zoneOf(await getSettings(env.DB));
  const traffic = publicTraffic(f.traffic);
  if (o.countView !== false) await recordView(env.DB, report.id, now.toISOString());

  return {
    clientName: f.clientName,
    label: f.label,
    summary: report.summary,
    recommendation: report.recommendation,
    sites: f.sites.map((s) => ({
      domain: s.domain, uptimePercent: s.uptimePercent, coveredDays: s.coveredDays, monitoredSince: s.monitoredSince, incidents: s.incidents, longestOutageMinutes: s.longestOutageMinutes,
      updatesApplied: s.updatesApplied, updatesRolledBack: s.updatesRolledBack, updatesTracked: s.updatesTracked === true, backups: s.backups, speedScore: s.speedScore,
    })),
    edits: f.edits ? { usedMinutes: f.edits.usedMinutes, allowanceMinutes: f.edits.allowanceMinutes, state: f.edits.state, requestsDone: f.edits.requestsDone } : null,
    renewals: f.renewals.map((r) => ({ what: r.what, domain: r.domain, on: r.on })),
    ...(traffic ? { traffic } : {}),
    sentOn: dayKey(Date.parse(report.sentAt ?? "") || now.getTime(), tz),
  };
}
