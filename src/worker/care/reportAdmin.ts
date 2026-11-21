import { z } from "zod";
import { refreshReportApproval } from "../approvals/careReport";
import { reject } from "../approvals/decide";
import { clientBase } from "../documents/mail";
import { cancel, editSummary, getReport, revoke, type CareReport, type ReportStatus, type SummarySource } from "../db/careReports";
import { getBusiness } from "../db/businesses";
import type { Env } from "../env";
import { localDay } from "../monitoring/rollup";
import { cancelTasksFor } from "../queue/db";
import { CARE_REPORT_TARGET, CareReportResult } from "../queue/careReport";
import { editLedger, type EditLedger } from "./ledger";
import { reportLink } from "./reportMail";

// What the owner does with a month's reports (Plan 13): reads the list, edits the words of a `ready` one, takes one back. A report that is taken back or dropped also takes back its queued Claude
// job and its pending approval, so nothing is left waiting for a report that will never go out.

/** One report as the owner's list shows it. `link` only for a report whose page a client may open (`ready`, `sent`); the token itself is never a field. */
export interface ReportRow {
  id: string; clientId: string; client: string; period: string; status: ReportStatus; summary: string; recommendation: string; source: SummarySource;
  /** The booking-zone date the mail went out, or null. */
  sentOn: string | null; views: number; test: boolean; link: string | null; ledger: EditLedger | null;
}

export async function reportRow(env: Env, r: CareReport, tz: string): Promise<ReportRow> {
  const shown = r.status === "ready" || r.status === "sent";
  return {
    id: r.id, clientId: r.businessId, client: (await getBusiness(env.DB, r.businessId))?.name ?? "", period: r.period, status: r.status, summary: r.summary, recommendation: r.recommendation, source: r.summarySource,
    sentOn: r.sentAt ? localDay(r.sentAt, tz) : null, views: r.viewCount, test: r.test, link: shown ? reportLink(clientBase(env) ?? undefined, r.token) : null,
    ledger: await editLedger(env, r.businessId, r.period, tz),
  };
}

const STATE: Record<ReportStatus, string> = {
  collecting: "still collecting its numbers", ready: "ready", sent: "already sent", revoked: "already taken back", cancelled: "cancelled",
};

const WordsBody = z.object({ summary: z.string(), recommendation: z.string() }).strict();

/** The reason a field was refused as a sentence: the text rules say their own words, a length is said in numbers. */
function why(field: string, issues: { message: string }[], lengthRule: string): string {
  const rule = issues.find((i) => i.message.startsWith("must "));
  return `The ${field} ${rule ? rule.message : lengthRule}.`;
}

/**
 * Logan's words for a report: the same rules as the ones Claude's words pass (a limit of 600 and 300 characters, no link, address, price or markdown), but an empty recommendation is allowed (the code-written
 * summary has none). Both fields are trimmed. A refusal is a plain sentence naming the field.
 */
export function checkWords(body: unknown): { ok: true; summary: string; recommendation: string } | { ok: false; error: string } {
  const raw = WordsBody.safeParse(body);
  if (!raw.success) return { ok: false, error: "Send the summary and the recommendation, both as text." };
  const summary = CareReportResult.shape.summary.safeParse(raw.data.summary);
  if (!summary.success) return { ok: false, error: why("summary", summary.error.issues, "must be 1 to 600 characters") };
  if (raw.data.recommendation.trim() === "") return { ok: true, summary: summary.data, recommendation: "" };
  const recommendation = CareReportResult.shape.recommendation.safeParse(raw.data.recommendation);
  if (!recommendation.success) return { ok: false, error: why("recommendation", recommendation.error.issues, "must be 300 characters or fewer") };
  return { ok: true, summary: summary.data, recommendation: recommendation.data };
}

export type Done = { ok: true; report: CareReport } | { ok: false; status: 404 | 409; error: string };
const NOT_FOUND: Done = { ok: false, status: 404, error: "not found" };

/** Takes back the report's queued Claude job and rejects its pending approval (an approval already decided stays as it was). */
async function settle(env: Env, reportId: string, note: string): Promise<void> {
  await cancelTasksFor(env.DB, CARE_REPORT_TARGET, reportId);
  const approvalId = (await getReport(env.DB, reportId))?.approvalId;
  if (approvalId) await reject(env.DB, approvalId, note);
}

/**
 * Sets the words of a `ready` report (they become Logan's) and rewrites the pending approval's card to match, so he never approves text the card does not show. Refused with a sentence for a report
 * in any other state: once the mail has gone the words are the client's.
 */
export async function editReport(env: Env, id: string, words: { summary: string; recommendation: string }): Promise<Done> {
  const report = await getReport(env.DB, id);
  if (!report) return NOT_FOUND;
  if (!(await editSummary(env.DB, id, words))) return { ok: false, status: 409, error: `Only a ready report can be edited, and this one is ${STATE[report.status]}.` };
  const edited = (await getReport(env.DB, id))!;
  await refreshReportApproval(env, edited);
  return { ok: true, report: edited };
}

/** Takes back a `ready` or `sent` report: its link stops working, its Claude job is closed and its pending approval is rejected. */
export async function revokeReport(env: Env, id: string, now: Date): Promise<Done> {
  const report = await getReport(env.DB, id);
  if (!report) return NOT_FOUND;
  if (!(await revoke(env.DB, id, now.toISOString()))) return { ok: false, status: 409, error: `Only a ready or sent report can be taken back, and this one is ${STATE[report.status]}.` };
  await settle(env, id, "the report was revoked");
  return { ok: true, report: (await getReport(env.DB, id))! };
}

/** Drops a report that was never sent (`collecting` or `ready`), taking back its Claude job and its pending approval. False when it was not in either. */
export async function cancelReport(env: Env, id: string): Promise<boolean> {
  if (!(await cancel(env.DB, id))) return false;
  await settle(env, id, "the report was cancelled");
  return true;
}
