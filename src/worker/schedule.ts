import type { Env } from "./env";
import { runDueRadars } from "./radar-run";
import { searchWorkflowStarter } from "./search-start";
import { scanDueSteps } from "./sequence/engine";
import { syncAllMailboxes } from "./mail/sync";
import { requestMeetilySync } from "./meetings/syncKind";
import "./queue/kinds"; // expiring a task runs its kind's hook, so every kind must be registered
import { EXPIRE_AFTER_DAYS, expireOldTasks } from "./queue/db";
import { healCroHandovers } from "./queue/cro";
import "./helper/kinds"; // expiring a helper job runs its kind's hook, so every kind must be registered
import { expireOldHelperJobs } from "./helper/jobs";
import { sendDueReminders } from "./booking/reminders";
import { expireDue } from "./db/documents";
import { activityStmt } from "./db/activity";
import { sweepOnboardings } from "./onboarding/sweep";
import { sweepProjects } from "./projects/sweep";
import { sweepBilling } from "./billing/sweep";
import { sweepDomains, sweepUptime } from "./monitoring/sweep";
import { careBackstop, startWeeklyBatch } from "./care/batch";
import { sweepReports } from "./care/reportSweep";
import { queueCertCheck } from "./care/certsKind";
import { sweepSeo } from "./seo/sweep";
import { sweepLadder } from "./ladder/sweep";

/** The cron strings in wrangler.jsonc. The daily one MUST stay first there: test/radar-info.test.ts reads the first entry. */
export const DAILY_CRON = "17 13 * * *";
export const MAIL_SYNC_CRON = "*/15 * * * *";
/** Every five minutes: the booking reminders, which need a finer tick than the mail sync gives (a "10 minutes before" mail cannot land on a 15-minute one), then the Care uptime probe. */
export const REMINDER_CRON = "*/5 * * * *";

/**
 * One part of a cron run, logged and contained: its failure is never allowed to stop another part or fail the cron. A `quiet` part that
 * returns nothing logs nothing (the mail sync runs every 15 minutes and logs its own news).
 */
async function part(name: string, run: () => Promise<unknown>, quiet = false): Promise<void> {
  try {
    const r = await run();
    if (!(quiet && r === undefined)) console.log(name, r === undefined ? "done" : JSON.stringify(r));
  } catch (e) {
    console.error(`${name} failed`, e);
  }
}

/** Expires the proposals whose time has run out and logs each one once on its lead (a document is expired only once, so a second sweep logs nothing). Returns how many. */
async function expireProposals(env: Env, now: Date): Promise<number> {
  const expired = await expireDue(env.DB, now.toISOString());
  if (expired.length) await env.DB.batch(expired.map((d) => activityStmt(env.DB, d.businessId, "proposal_void", `${d.content.header.reference} v${d.version}: expired`)));
  return expired.length;
}

/**
 * Routes one Cron Trigger. The 15-minute cron only syncs mail and queues the Mac helper's Meetily pull (a failure of one never stops the other), and the 5-minute one sends due booking reminders and then probes the monitored Care sites (records checks and opens or closes down incidents; sends nothing). Any other cron (the daily one) does, in order:
 * starts due radars, scans for due sequence steps, gives up on Claude tasks and Mac helper jobs nobody picked up in 14 days, expires proposals past their date,
 * re-queues CRO roadmaps that were never handed over, sweeps the open client onboardings (drafts the reminder or Friday update that is due, as an approval,
 * and notes 14 days of silence), and sweeps the projects (makes this period's recurring tasks, starts the projects a paid proposal never got, sends the Claude steps that are
 * ready, expires change orders past their date, and saves a timer left running past its cap), and last sweeps the billing (drafts the milestone invoices a hook never made, plans and
 * proposes subscriptions, drafts the reminders and pause notices that are due and places the holds, notices or converts the terms that end, and settles the open invoices whose webhook never
 * came), then looks up the expiry of the monitored sites' domains, rolls the uptime up and deletes old uptime checks, starts the weekly Care update batch on its weekday (read-only inventories; the update waves are approvals), runs the Care batch backstop, queues the certificate checks, starts the monthly Care report of each live Care client (queues Claude's summary; nothing is sent), sweeps the Local SEO clients (watches the reviews, pulls the month's ranks and content slots, starts last month's report; nothing is sent or published) and, last, sweeps the post-launch ladder (adds the steps of a finished build that the hook missed and the December letters, skips what is too late, marks the thank-you and case study steps due and drafts the review, testimonial, check-in and December mails as approvals; nothing is sent). This is unattended work: it can start searches, create approvals and holds, queue Claude steps and close queue tasks, and it never throws. It sends nothing itself, with one exception: the billing and onboarding sweeps may send the two fixed reminder kinds (`invoice.reminder`, `onboarding.nudge`) that the owner has switched auto-approve on for, and only through the ordinary `approve()` (see approvals/auto.ts).
 */
export async function runScheduled(env: Env, cron: string, now: Date): Promise<void> {
  if (cron === MAIL_SYNC_CRON) {
    await part("mail sync", () => syncAllMailboxes(env), true);
    // Quiet unless a sync job was queued: it runs 96 times a day, mostly with nothing to match or a job still open.
    await part("meeting sync", async () => { const r = await requestMeetilySync(env, now); return r.queued ? r : undefined; }, true);
    return;
  }
  if (cron === REMINDER_CRON) {
    // Quiet unless a reminder went out or was held back: it runs 288 times a day.
    await part("booking reminders", async () => { const r = await sendDueReminders(env, now); return r.sent || r.skipped ? r : undefined; }, true);
    // Quiet unless an incident opened or closed: the probe records a check per site on every tick.
    await part("uptime", async () => { const r = await sweepUptime(env, now); return r.opened || r.closed ? r : undefined; }, true);
    return;
  }
  await part("radar run", () => runDueRadars({ db: env.DB, now: () => now, startWorkflow: searchWorkflowStarter(env) }));
  await part("sequence scan", () => scanDueSteps(env, now));
  await part("expire tasks", () => expireOldTasks(env, now, EXPIRE_AFTER_DAYS));
  await part("expire helper jobs", () => expireOldHelperJobs(env, now));
  await part("expire proposals", () => expireProposals(env, now));
  await part("cro heal", () => healCroHandovers(env));
  await part("onboarding sweep", () => sweepOnboardings(env, now));
  await part("project sweep", () => sweepProjects(env, now));
  await part("billing sweep", () => sweepBilling(env, now));
  await part("domain expiry", () => sweepDomains(env, now));
  await part("care updates", () => startWeeklyBatch(env, now));
  await part("care backstop", () => careBackstop(env, now));
  await part("certificates", () => queueCertCheck(env, now));
  // Last: it must follow the project sweep (it makes the month's CARE-4 task) and the domain sweep (its uptime rollup settles the month's last day), and it is the one part that can run long on the 1st (a PageSpeed
  // call per site, client after client), so it must not starve the parts above of their time.
  await part("care reports", () => sweepReports(env, now));
  // After the Care reports for the same reason: it makes Places calls, a rank grid per client, and must not starve the parts above of their time.
  await part("seo", () => sweepSeo(env, now));
  // After the Local SEO sweep: it makes no outside calls (only approvals), so it never starves the parts above, and a client that sweep just touched is read as it stands.
  await part("ladder", () => sweepLadder(env, now));
}
