import { z } from "zod";
import { mainMailboxProblem } from "../booking/mail";
import { invoiceRecipient, signOff, type Recipient } from "../billing/mail";
import { renderReportMail, reportLink } from "../care/reportMail";
import { ReportFacts } from "../care/reportFacts";
import { CARE_4, tickCare4 } from "../care/tasks";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import { createApprovalOnce, updatePendingCard, type Approval } from "../db/approvals";
import { getReport, markSent, setTaskAndApproval, type CareReport } from "../db/careReports";
import { isOnHold } from "../db/holds";
import { getByApproval } from "../db/messages";
import { CARE_SUBSCRIPTION_SQL } from "../db/monitoring";
import { liveProjectSql } from "../db/projects";
import { getSettings } from "../db/settings";
import { clientBase } from "../documents/mail";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { periodKey, periodLabel, zoneOf } from "../sop/cadence";
import { registerHandler } from "./registry";

const KIND = "care.report";
const Payload = z.object({ reportId: z.string().min(1) });
export type CareReportApprovalPayload = z.infer<typeof Payload>;

/** Said on the card and in the refusal when there is no link to make: it names the setting to fix. */
export const NO_LINK_BASE = "there is no usable client link address (set CLIENT_LINK_BASE to an https address of your own, not the cold-email host)";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The id of the client's live Care project (one that carries the monthly report cadence), or null. */
async function liveCareProject(db: D1Database, businessId: string): Promise<string | null> {
  const r = await db.prepare(
    `SELECT p.id FROM project_cadences c JOIN projects p ON p.id = c.project_id WHERE p.business_id = ? AND c.template_key = ? AND ${liveProjectSql("p")} ORDER BY c.created_at, c.id LIMIT 1`,
  ).bind(businessId, CARE_4).first<{ id: string }>();
  return r?.id ?? null;
}

const hasLiveCareSubscription = async (db: D1Database, businessId: string): Promise<boolean> =>
  !!(await db.prepare(`SELECT 1 AS x FROM businesses b WHERE b.id = ? AND ${CARE_SUBSCRIPTION_SQL("b")}`).bind(businessId).first());

/** The headline numbers of the report, one line per site and one for the edit time: what the client will find on the report page. A number that was not measured is said so, never shown as zero. */
function headlineLines(f: ReportFacts): string[] {
  const lines = f.sites.map((s) => {
    const parts = [
      s.uptimePercent === null ? "uptime not measured" : `up ${s.uptimePercent}% over ${plural(s.coveredDays, "day", "days")} checked`,
      plural(s.incidents, "incident", "incidents") + (s.incidents > 0 && s.longestOutageMinutes !== null ? ` (longest about ${plural(s.longestOutageMinutes, "minute", "minutes")})` : ""),
    ];
    // The update and backup counts are only said for a site an update run covered: for another they were not measured, and "0 updates" would read as a measurement.
    if (s.updatesTracked === true) {
      parts.push(`${plural(s.updatesApplied, "update", "updates")} applied`);
      if (s.updatesRolledBack) parts.push(`${s.updatesRolledBack} rolled back`);
      if (s.updatesFailed) parts.push(`${s.updatesFailed} failed`);
      parts.push(plural(s.backups, "backup", "backups"));
    }
    parts.push(s.speedScore === null ? "speed not measured" : `mobile speed ${s.speedScore} out of 100`);
    return `- ${s.domain}: ${parts.join(", ")}`;
  });
  if (!f.sites.length) lines.push("- No monitored sites.");
  if (f.edits) {
    const used = f.edits.allowanceMinutes > 0 ? `${f.edits.usedMinutes} of ${f.edits.allowanceMinutes} edit minutes used` : `${f.edits.usedMinutes} edit minutes used`;
    lines.push(`- Edit time: ${used}, ${plural(f.edits.requestsDone, "edit request", "edit requests")} done`);
  }
  for (const r of f.renewals) lines.push(`- Coming up: ${r.what.replace("_", " ")}${r.domain ? ` for ${r.domain}` : ""} on ${r.on}`);
  return lines;
}

const SOURCE_NOTE: Record<CareReport["summarySource"], string> = {
  claude: "Written by Claude from the numbers.",
  plain: "This summary was not written by Claude: the code wrote it from the numbers because Claude's draft did not arrive. Read it before you approve.",
  logan: "In your own words (you edited it).",
  none: "No summary has been written.",
};

/**
 * The approval's title and preview from the report as it is now: who it goes to, the subject, the mail as it will read (the summary and the link) and, below it, what the client will find on the report page
 * (the recommendation and the headline numbers). A recipient or a link that cannot be made yet is said on the card, never thrown: the card is made either way, and the approval refuses or throws when it runs.
 */
async function describe(env: Env, report: CareReport): Promise<{ title: string; preview: string }> {
  const db = env.DB;
  const settings = await getSettings(db);
  const facts = ReportFacts.safeParse(report.facts);
  const label = periodLabel("monthly", report.period);
  let who: Recipient | null = null;
  let whoProblem = "";
  try { who = await invoiceRecipient(env, { documentId: null, projectId: await liveCareProject(db, report.businessId), businessId: report.businessId }); }
  catch (e) { whoProblem = e instanceof Error ? e.message : "no contact"; }
  const owner = settings.contact_email.trim();
  const link = reportLink(clientBase(env) ?? undefined, report.token);
  const clientName = (facts.success && facts.data.clientName) || who?.clientName || "this client";
  const mail = renderReportMail({ clientName, contactName: who?.contactName ?? "", yourName: signOff(settings), summary: report.summary, link: link ?? "(no link yet)", period: label });

  const contact = who ? `${who.contactName || who.clientName} <${who.to}>` : `nobody yet (this client has no contact email: add one first; ${whoProblem})`;
  const to = report.test ? `${owner || "your contact email (not set: add it in Settings first)"} (a test: nothing goes to ${contact})` : contact;
  const preview = [
    `To: ${to}`, `Subject: ${report.test ? "[Test] " : ""}${mail.subject}`, "",
    SOURCE_NOTE[report.summarySource], "", mail.body, "",
    ...(link ? [] : [`The link cannot be made: ${NO_LINK_BASE}.`, ""]),
    "On the report page (not in the mail):", `Recommendation: ${report.recommendation.trim() || "none"}`, "Headline numbers:",
    ...(facts.success ? headlineLines(facts.data) : ["- The numbers could not be read."]), "",
    "Nothing is mailed until you approve.",
  ].join("\n");
  return { title: `Send the ${label} report to ${clientName}`, preview };
}

const existingApproval = async (db: D1Database, reportId: string): Promise<string | null> =>
  (await db.prepare(`SELECT id FROM approvals WHERE kind = ? AND json_extract(payload, '$.reportId') = ? ORDER BY created_at, id LIMIT 1`).bind(KIND, reportId).first<{ id: string }>())?.id ?? null;

/**
 * Puts the mail of a `ready` report up for approval: one approval per report, in any state (a second call, a racing one, or a call after Logan decided returns the first one's id), recorded on the report.
 * Null only for a report that is not `ready`; for a `ready` one it returns an id or throws. Nothing is mailed until Logan approves.
 */
export async function proposeReportApproval(env: Env, report: CareReport): Promise<string | null> {
  if (report.status !== "ready") return null;
  const db = env.DB;
  let id = await existingApproval(db, report.id);
  if (!id) {
    const d = await describe(env, report);
    const made = await createApprovalOnce(db, {
      kind: KIND, title: d.title, preview: d.preview, payload: { reportId: report.id } satisfies CareReportApprovalPayload, record_type: "business", record_id: report.businessId, drafted_by: "logan",
    }, "reportId", report.id);
    id = made?.id ?? (await existingApproval(db, report.id)); // two callers at once: the earliest approval stands
  }
  if (!id) throw new Error("Could not make the approval for the monthly report.");
  await setTaskAndApproval(db, report.id, { approvalId: id });
  return id;
}

/**
 * Rewrites the card of the report's approval, if it is still pending, from the report as it is now, so Logan approves the words the card shows (the card is built when the approval is proposed, while the mail
 * is built from the live row when it runs). A decided approval, or a report with none, is left alone. True when a card was rewritten.
 */
export async function refreshReportApproval(env: Env, report: CareReport): Promise<boolean> {
  const id = await existingApproval(env.DB, report.id);
  if (!id) return false;
  return updatePendingCard(env.DB, id, await describe(env, report));
}

/**
 * What follows the mail: the report is `sent` (a no-op when it already is), the timeline says so once, and CARE-4's 1.2 and 1.3 are ticked on the task of the month the mail went out in. `sentAt` is when it
 * really went (a retry passes the mail row's own time, so a retry across a month boundary neither moves `sent_at` nor ticks the next month's task). Safe to repeat.
 */
async function afterMail(env: Env, report: CareReport, to: string, sentAt: Date): Promise<void> {
  const db = env.DB;
  await markSent(db, report.id, sentAt.toISOString());
  await logActivityOnce(db, report.businessId, "care_report_sent", `${periodLabel("monthly", report.period)} report sent to ${to}${report.test ? " (test)" : ""}`);
  const ticked = await tickCare4(env, report.businessId, periodKey("monthly", sentAt, zoneOf(await getSettings(db))), ["1.2", "1.3"], sentAt);
  // A rehearsal client has no CARE-4 task (the daily sweep makes none for a test client), so a test report's mail is not an error.
  if (!ticked && !report.test) console.error("care report: the monthly report task was not ticked after the mail went out");
}

const NOT_READY: Record<Exclude<CareReport["status"], "ready">, string> = {
  collecting: "the report is not ready yet",
  sent: "the report was already sent",
  revoked: "the report was taken back (revoked)",
  cancelled: "the report was cancelled",
};

registerHandler({
  kind: KIND,
  label: "Send monthly report",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the report id is trusted from the payload. A mail that already went out under this approval only finishes what comes after it (marks
   * the report sent, logs once, ticks CARE-4, from the mail's own time). Otherwise a report that is no longer `ready`, a client with no live Care project (or, for a real report, no live Care subscription) gets
   * nothing, and the timeline says why (those cannot clear up, so that approval is used up). What can clear up throws, so the approval goes back to pending and is approved again once it does: a billing hold, a link base that
   * is not usable, a mailbox that cannot send, a contact with no email and a blocked address. The mail goes with the approval id as the once-only key; a test report goes to the owner only, with "[Test] " on the subject. CARE-4 is ticked only after the mail really went.
   */
  async execute(env: Env, p: CareReportApprovalPayload, a: Approval) {
    const db = env.DB;
    const report = await getReport(db, p.reportId);
    if (!report) throw new Error("This report was not found.");
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await afterMail(env, report, mailed.counterpart, mailed.sent_at ? new Date(mailed.sent_at) : getMailDeps().now()); return; } // an earlier run of this approval mailed it and something after the mail failed

    const label = periodLabel("monthly", report.period);
    const skip = async (why: string) => { await logActivityOnce(db, report.businessId, "note", `monthly report not sent: ${label}: ${why}, so nothing was mailed`); };
    if (report.status !== "ready") { await skip(NOT_READY[report.status]); return; }
    const projectId = await liveCareProject(db, report.businessId);
    if (!projectId) { await skip("the client has no live Care project"); return; }
    if (!report.test) {
      if (!(await hasLiveCareSubscription(db, report.businessId))) { await skip("the client has no live Care subscription"); return; }
      if (await isOnHold(db, report.businessId)) throw new Error("This client is on a billing hold, so the report was not mailed. Approve it again once the hold is lifted.");
    }
    const link = reportLink(clientBase(env) ?? undefined, report.token);
    if (!link) throw new Error(`The report was not mailed: ${NO_LINK_BASE}. Approve it again once that is fixed.`);

    const settings = await getSettings(db);
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, { documentId: null, projectId, businessId: report.businessId });
    const owner = settings.contact_email.trim();
    if (report.test && !owner) throw new Error("Add your contact email in Settings first: a test report goes to it.");
    if (!report.test) {
      // The client has paid before, so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: report.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    const facts = ReportFacts.safeParse(report.facts);
    const mail = renderReportMail({ clientName: (facts.success && facts.data.clientName) || who.clientName, contactName: who.contactName, yourName: signOff(settings), summary: report.summary, link, period: label });
    const to = report.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${report.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(report.test ? {} : { businessId: report.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await afterMail(env, report, to, getMailDeps().now());
  },
});
