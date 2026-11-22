import { z } from "zod";
import { mainMailboxProblem } from "../booking/mail";
import { invoiceRecipient, signOff, type Recipient } from "../billing/mail";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import { createApprovalOnce, updatePendingCard, type Approval } from "../db/approvals";
import { isOnHold } from "../db/holds";
import { getByApproval } from "../db/messages";
import { liveProjectSql } from "../db/projects";
import { getSeoReport, markSeoSent, setSeoTaskAndApproval, type SeoReport } from "../db/seoReports";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { periodKey, periodLabel, zoneOf } from "../sop/cadence";
import { SeoReportFacts } from "../seo/reportFacts";
import { renderSeoReportMail, seoReportLink } from "../seo/reportMail";
import { SEO_1, tickSeo1 } from "../seo/tasks";
import { registerHandler } from "./registry";

// The approval of a client's monthly Local SEO report (Plan 14), the mirror of the Care report's (Plan 13): one approval per report, the mail goes only when Logan approves, and everything is read again
// when it runs. The direction of imports is queue -> approvals (the task kind proposes this approval), never the other way.

const KIND = "seo.report";
const Payload = z.object({ reportId: z.string().min(1) });
export type SeoReportApprovalPayload = z.infer<typeof Payload>;

/** Said on the card and in the refusal when there is no link to make: it names the setting to fix. */
export const NO_LINK_BASE = "there is no usable client link address (set CLIENT_LINK_BASE to an https address of your own, not the cold-email host)";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dayText = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""} ${Number(day.slice(8, 10))}`.trim();

/** The id of the client's live Local SEO project (one that carries the monthly SEO-1 cadence, the same rule as the daily sweep's), or null. */
async function liveSeoProject(db: D1Database, businessId: string): Promise<string | null> {
  const r = await db.prepare(
    `SELECT p.id FROM project_cadences c JOIN projects p ON p.id = c.project_id WHERE p.business_id = ? AND c.template_key = ? AND ${liveProjectSql("p")} ORDER BY c.created_at, c.id LIMIT 1`,
  ).bind(businessId, SEO_1).first<{ id: string }>();
  return r?.id ?? null;
}

/** The headline numbers of the report, one line each: what the client will find on the report page. A number that was not measured is said so, never shown as zero. */
function headlineLines(f: SeoReportFacts): string[] {
  const lines: string[] = [];
  if (f.rankAsOf === null) lines.push("- Rank check: no rank check was available for this report.");
  else lines.push(`- Rank check: in our check on ${dayText(f.rankAsOf)}${f.previousRankAsOf === null ? " (the first check, nothing earlier to compare with)" : `, compared with the check on ${dayText(f.previousRankAsOf)}`}.`);
  for (const t of f.terms) {
    const name = `${t.term}${t.town ? ` in ${t.town}` : ""}`;
    if (t.visible === null) lines.push(`- ${name}: not enough points were checked to say (${t.measured} of ${t.points.length || 9} measured).`);
    else {
      const before = f.previousRankAsOf !== null && t.previousVisible !== null ? `, ${plural(t.previousVisible, "point", "points")} at the previous check` : "";
      lines.push(`- ${name}: top 3 at ${t.visible} of ${t.measured} points${before}.`);
    }
  }
  const g = f.gbp;
  const profile = [
    g.rating !== null ? `${g.rating} out of 5` : null,
    g.reviewCount !== null ? plural(g.reviewCount, "review", "reviews") : null,
    g.reviewsGained !== null ? `gained ${plural(g.reviewsGained, "review", "reviews")} since the previous check` : null,
  ].filter((x): x is string => x !== null);
  lines.push(`- Google profile: ${profile.length ? profile.join(", ") : "not measured"}.`);
  lines.push(`- Reviews first seen this month: ${f.reviews.seen}, ${plural(f.reviews.posted, "reply", "replies")} posted${f.reviews.needsYou > 0 ? `, ${plural(f.reviews.needsYou, "low-rated review still needs", "low-rated reviews still need")} an answer` : ""}.`);
  const titles = f.content.published.map((c) => `${c.kind.replace("_", " ")} "${c.title}"`);
  lines.push(`- Content published: ${titles.length ? `${titles.length} (${titles.join("; ")})` : "none"}.`);
  lines.push(f.citations ? `- Directory listings: ${f.citations.listed} listed, ${f.citations.needsFix} need fixing, ${f.citations.todo} still to do.` : "- Directory listings: no list for this client.");
  return lines;
}

const SOURCE_NOTE: Record<SeoReport["summarySource"], string> = {
  claude: "Written by Claude from the numbers.",
  plain: "This summary was not written by Claude: the code wrote it from the numbers because Claude's draft did not arrive. Read it before you approve.",
  logan: "In your own words (you edited it).",
  none: "No summary has been written.",
};

/**
 * The approval's title and preview from the report as it is now: who it goes to, the subject, the mail as it will read (the summary and the link) and, below it, what the client will find on the report page
 * (the recommendation, the three priorities and the headline numbers). A recipient or a link that cannot be made yet is said on the card, never thrown: the card is made either way, and the approval refuses or
 * throws when it runs.
 */
async function describe(env: Env, report: SeoReport): Promise<{ title: string; preview: string }> {
  const db = env.DB;
  const settings = await getSettings(db);
  const facts = SeoReportFacts.safeParse(report.facts);
  const label = periodLabel("monthly", report.period);
  let who: Recipient | null = null;
  let whoProblem = "";
  try { who = await invoiceRecipient(env, { documentId: null, projectId: await liveSeoProject(db, report.businessId), businessId: report.businessId }); }
  catch (e) { whoProblem = e instanceof Error ? e.message : "no contact"; }
  const owner = settings.contact_email.trim();
  const link = seoReportLink(env, report.token);
  const clientName = (facts.success && facts.data.clientName) || who?.clientName || "this client";
  const mail = renderSeoReportMail({ clientName, contactName: who?.contactName ?? "", yourName: signOff(settings), summary: report.summary, link: link ?? "(no link yet)", period: label });

  const contact = who ? `${who.contactName || who.clientName} <${who.to}>` : `nobody yet (this client has no contact email: add one first; ${whoProblem})`;
  const to = report.test ? `${owner || "your contact email (not set: add it in Settings first)"} (a test: nothing goes to ${contact})` : contact;
  const priorities = report.priorities.length ? report.priorities.map((p, i) => `${i + 1}. ${p}`) : ["No priorities were written."];
  const preview = [
    `To: ${to}`, `Subject: ${report.test ? "[Test] " : ""}${mail.subject}`, "",
    SOURCE_NOTE[report.summarySource], "", mail.body, "",
    ...(link ? [] : [`The link cannot be made: ${NO_LINK_BASE}.`, ""]),
    "On the report page (not in the mail):", `Recommendation: ${report.recommendation.trim() || "none"}`, "Priorities for next month:", ...priorities, "Headline numbers:",
    ...(facts.success ? headlineLines(facts.data) : ["- The numbers could not be read."]), "",
    "Nothing is mailed until you approve.",
  ].join("\n");
  return { title: `Send the ${label} Local SEO report to ${clientName}`, preview };
}

const existingApproval = async (db: D1Database, reportId: string): Promise<string | null> =>
  (await db.prepare(`SELECT id FROM approvals WHERE kind = ? AND json_extract(payload, '$.reportId') = ? ORDER BY created_at, id LIMIT 1`).bind(KIND, reportId).first<{ id: string }>())?.id ?? null;

/**
 * Puts the mail of a `ready` report up for approval: one approval per report, in any state (a second call, a racing one, or a call after Logan decided returns the first one's id), recorded on the report.
 * A report that is not `ready` and has no approval has nothing to approve and throws. Nothing is mailed until Logan approves.
 */
export async function proposeSeoReportApproval(env: Env, report: SeoReport): Promise<string> {
  const db = env.DB;
  let id = await existingApproval(db, report.id);
  if (!id) {
    if (report.status !== "ready") throw new Error("The Local SEO report is not ready, so there is nothing to approve.");
    const d = await describe(env, report);
    const made = await createApprovalOnce(db, {
      kind: KIND, title: d.title, preview: d.preview, payload: { reportId: report.id } satisfies SeoReportApprovalPayload, record_type: "business", record_id: report.businessId, drafted_by: "job",
    }, "reportId", report.id);
    id = made?.id ?? (await existingApproval(db, report.id)); // two callers at once: the earliest approval stands
  }
  if (!id) throw new Error("Could not make the approval for the Local SEO report.");
  await setSeoTaskAndApproval(db, report.id, { approvalId: id });
  return id;
}

/**
 * Rewrites the card of the report's approval, if it is still pending, from the report as it is now, so Logan approves the words the card shows (the card is built when the approval is proposed, while the mail
 * is built from the live row when it runs). A decided approval, or a report with none, is left alone. True when a card was rewritten.
 */
export async function refreshSeoReportApproval(env: Env, report: SeoReport): Promise<boolean> {
  const id = await existingApproval(env.DB, report.id);
  if (!id) return false;
  return updatePendingCard(env.DB, id, await describe(env, report));
}

/**
 * What follows the mail: the report is `sent` (a no-op when it already is), the timeline says so once, and SEO-1's 1.7 is ticked on the task of the month the mail went out in. `sentAt` is when it really
 * went (a retry passes the mail row's own time, so a retry across a month boundary neither moves `sent_at` nor ticks the next month's task). Safe to repeat.
 */
async function afterMail(env: Env, report: SeoReport, to: string, sentAt: Date): Promise<void> {
  const db = env.DB;
  await markSeoSent(db, report.id, sentAt.toISOString());
  await logActivityOnce(db, report.businessId, "seo_report_sent", `${periodLabel("monthly", report.period)} Local SEO report sent to ${to}${report.test ? " (test)" : ""}`);
  const ticked = await tickSeo1(env, report.businessId, periodKey("monthly", sentAt, zoneOf(await getSettings(db))), ["1.7"], sentAt);
  // A rehearsal client has no SEO-1 task (the daily sweep makes none for a test client), so a test report's mail is not an error.
  if (!ticked && !report.test) console.error("seo report: the monthly task was not ticked after the mail went out");
}

const NOT_READY: Record<Exclude<SeoReport["status"], "ready">, string> = {
  collecting: "the report is not ready yet",
  sent: "the report was already sent",
  revoked: "the report was taken back (revoked)",
  cancelled: "the report was cancelled",
};

registerHandler({
  kind: KIND,
  label: "Send monthly Local SEO report",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the report id is trusted from the payload. A mail that already went out under this approval only finishes what comes after it (marks
   * the report sent, logs once, ticks SEO-1, from the mail's own time). Otherwise a report that is no longer `ready`, or a client with no live Local SEO project, gets nothing, and the timeline says why (those cannot
   * clear up, so that approval is used up). What can clear up throws, so the approval goes back to pending and is approved again once it does: a billing hold, a link base that is not usable, a mailbox that cannot
   * send, a contact with no email and a blocked address. The mail goes with the approval id as the once-only key; a test report goes to the owner only, with "[Test] " on the subject. SEO-1 is ticked only after the
   * mail really went.
   */
  async execute(env: Env, p: SeoReportApprovalPayload, a: Approval) {
    const db = env.DB;
    const report = await getSeoReport(db, p.reportId);
    if (!report) throw new Error("This report was not found.");
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await afterMail(env, report, mailed.counterpart, mailed.sent_at ? new Date(mailed.sent_at) : getMailDeps().now()); return; } // an earlier run of this approval mailed it and something after the mail failed

    const label = periodLabel("monthly", report.period);
    const skip = async (why: string) => { await logActivityOnce(db, report.businessId, "note", `Local SEO report not sent: ${label}: ${why}, so nothing was mailed`); };
    if (report.status !== "ready") { await skip(NOT_READY[report.status]); return; }
    const projectId = await liveSeoProject(db, report.businessId);
    if (!projectId) { await skip("the client has no live Local SEO project"); return; }
    if (!report.test && (await isOnHold(db, report.businessId))) throw new Error("This client is on a billing hold, so the report was not mailed. Approve it again once the hold is lifted.");
    const link = seoReportLink(env, report.token);
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

    const facts = SeoReportFacts.safeParse(report.facts);
    const mail = renderSeoReportMail({ clientName: (facts.success && facts.data.clientName) || who.clientName, contactName: who.contactName, yourName: signOff(settings), summary: report.summary, link, period: label });
    const to = report.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${report.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(report.test ? {} : { businessId: report.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await afterMail(env, report, to, getMailDeps().now());
  },
});
