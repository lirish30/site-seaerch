import { z } from "zod";
import { refreshSeoReportApproval } from "../approvals/seoReport";
import { reject } from "../approvals/decide";
import { getBusiness } from "../db/businesses";
import { editSeoSummary, getSeoReport, revokeSeoReport, type SeoReport, type SeoReportStatus, type SeoSummarySource } from "../db/seoReports";
import type { Env } from "../env";
import { localDay } from "../monitoring/rollup";
import { cancelTasksFor } from "../queue/db";
import { SEO_REPORT_TARGET, SeoReportResult } from "../queue/seoReport";
import { seoReportLink } from "./reportMail";

// What the owner does with a month's Local SEO reports (Plan 14): reads the list, edits the words of a `ready` one, takes one back. The mirror of the Care report's admin (Plan 13). A report that is taken back
// also takes back its queued Claude job and its pending approval, so nothing is left waiting for a report that will never go out.

/** One report as the owner's list shows it. `link` only for a report whose page a client may open (`ready`, `sent`); the token itself is never a field. */
export interface SeoReportRow {
  id: string; clientId: string; client: string; period: string; status: SeoReportStatus; summary: string; recommendation: string; priorities: string[]; source: SeoSummarySource;
  /** The booking-zone date the mail went out, or null. */
  sentOn: string | null; views: number; test: boolean; link: string | null;
}

export async function seoReportRow(env: Env, r: SeoReport, tz: string): Promise<SeoReportRow> {
  const shown = r.status === "ready" || r.status === "sent";
  return {
    id: r.id, clientId: r.businessId, client: (await getBusiness(env.DB, r.businessId))?.name ?? "", period: r.period, status: r.status, summary: r.summary, recommendation: r.recommendation,
    priorities: r.priorities, source: r.summarySource, sentOn: r.sentAt ? localDay(r.sentAt, tz) : null, views: r.viewCount, test: r.test, link: shown ? seoReportLink(env, r.token) : null,
  };
}

const STATE: Record<SeoReportStatus, string> = {
  collecting: "still collecting its numbers", ready: "ready", sent: "already sent", revoked: "already taken back", cancelled: "cancelled",
};

const WordsBody = z.object({ summary: z.string(), recommendation: z.string(), priorities: z.array(z.string()) }).strict();

const LENGTH_RULE = { summary: "must be 1 to 600 characters", recommendation: "must be 1 to 300 characters", priority: "must be 1 to 120 characters" } as const;

/**
 * Logan's words for a report: the very same rules Claude's words pass (`SeoReportResult`, the one validator): a summary of 1 to 600 characters, a recommendation of 1 to 300, exactly three priorities of 1 to 120,
 * and in all of them no link, address, price, markdown, run of blank lines or promise about a ranking or a result. Every field is trimmed. A refusal is a plain sentence naming the field.
 */
export function checkSeoWords(body: unknown): { ok: true; summary: string; recommendation: string; priorities: string[] } | { ok: false; error: string } {
  const raw = WordsBody.safeParse(body);
  if (!raw.success) return { ok: false, error: "Send the summary, the recommendation and three priorities, all as text." };
  if (raw.data.priorities.length !== 3) return { ok: false, error: "Give exactly three priorities." };
  const parsed = SeoReportResult.safeParse(raw.data);
  if (parsed.success) return { ok: true, summary: parsed.data.summary, recommendation: parsed.data.recommendation, priorities: [...parsed.data.priorities] };
  // The first field that failed speaks (summary, recommendation, then the priorities in order): the text rules say their own words, a length is said in numbers.
  const fields: { name: string; path: (string | number)[]; length: string }[] = [
    { name: "The summary", path: ["summary"], length: LENGTH_RULE.summary },
    { name: "The recommendation", path: ["recommendation"], length: LENGTH_RULE.recommendation },
    ...[0, 1, 2].map((i) => ({ name: `Priority ${i + 1}`, path: ["priorities", i], length: LENGTH_RULE.priority })),
  ];
  for (const f of fields) {
    const issues = parsed.error.issues.filter((i) => f.path.every((p, k) => i.path[k] === p));
    if (!issues.length) continue;
    const rule = issues.find((i) => i.message.startsWith("must "));
    return { ok: false, error: `${f.name} ${rule ? rule.message : f.length}.` };
  }
  return { ok: false, error: "Those words can't be used." };
}

export type SeoDone = { ok: true; report: SeoReport } | { ok: false; status: 404 | 409; error: string };
const NOT_FOUND: SeoDone = { ok: false, status: 404, error: "not found" };

/** Takes back the report's queued Claude job and rejects its pending approval (an approval already decided stays as it was). */
async function settle(env: Env, reportId: string, note: string): Promise<void> {
  await cancelTasksFor(env.DB, SEO_REPORT_TARGET, reportId);
  const approvalId = (await getSeoReport(env.DB, reportId))?.approvalId;
  if (approvalId) await reject(env.DB, approvalId, note);
}

/**
 * Sets the words of a `ready` report (they become Logan's; `words` has passed `checkSeoWords`) and rewrites the pending approval's card to match, so he never approves text the card does not show. Refused with a
 * sentence for a report in any other state: once the mail has gone the words are the client's.
 */
export async function editSeoReport(env: Env, id: string, words: { summary: string; recommendation: string; priorities: string[] }): Promise<SeoDone> {
  const report = await getSeoReport(env.DB, id);
  if (!report) return NOT_FOUND;
  if (!(await editSeoSummary(env.DB, id, words))) return { ok: false, status: 409, error: `Only a ready report can be edited, and this one is ${STATE[report.status]}.` };
  const edited = (await getSeoReport(env.DB, id))!;
  await refreshSeoReportApproval(env, edited);
  return { ok: true, report: edited };
}

/** Takes back a `ready` or `sent` report: its link stops working, its Claude job is closed and its pending approval is rejected. */
export async function revokeSeoReportNow(env: Env, id: string, now: Date): Promise<SeoDone> {
  const report = await getSeoReport(env.DB, id);
  if (!report) return NOT_FOUND;
  if (!(await revokeSeoReport(env.DB, id, now.toISOString()))) return { ok: false, status: 409, error: `Only a ready or sent report can be taken back, and this one is ${STATE[report.status]}.` };
  await settle(env, id, "the report was revoked");
  return { ok: true, report: (await getSeoReport(env.DB, id))! };
}
