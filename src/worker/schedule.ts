import type { Env } from "./env";
import { runDueRadars } from "./radar-run";
import { searchWorkflowStarter } from "./search-start";
import { scanDueSteps } from "./sequence/engine";
import { syncAllMailboxes } from "./mail/sync";

/** The cron strings in wrangler.jsonc. The daily one MUST stay first there: test/radar-info.test.ts reads the first entry. */
export const DAILY_CRON = "17 13 * * *";
export const MAIL_SYNC_CRON = "*/15 * * * *";

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

/**
 * Routes one Cron Trigger. The 15-minute cron only syncs mail. Any other cron (the daily one) starts due radars and then scans for due
 * sequence steps. This is unattended work: it can only start searches and create approvals, never send, and it never throws.
 */
export async function runScheduled(env: Env, cron: string, now: Date): Promise<void> {
  if (cron === MAIL_SYNC_CRON) {
    await part("mail sync", () => syncAllMailboxes(env), true);
    return;
  }
  await part("radar run", () => runDueRadars({ db: env.DB, now: () => now, startWorkflow: searchWorkflowStarter(env) }));
  await part("sequence scan", () => scanDueSteps(env, now));
}
