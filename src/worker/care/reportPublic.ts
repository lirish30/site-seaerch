import { dayKey } from "../booking/slots";
import { getReportByToken, recordView } from "../db/careReports";
import { getSettings } from "../db/settings";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { videoKeyOf } from "../report/videoPublic";
import { zoneOf } from "../sop/cadence";
import { publicTraffic, type PublicTraffic } from "../traffic/public";
import { ReportFacts } from "./reportFacts";

export type { PublicTraffic };

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
  /** True when the report has a finished video the page can play (`GET /api/public/m/<token>/video.mp4`). Never the file's key. */
  video: boolean;
  /** The day the report was sent, `YYYY-MM-DD` in the booking zone. */
  sentOn: string;
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
    video: (await videoKeyOf(env.DB, "care", report)) !== null,
    sentOn: dayKey(Date.parse(report.sentAt ?? "") || now.getTime(), tz),
  };
}
