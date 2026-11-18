import type { Env } from "../env";

/** Pulls new mail for every enabled mailbox and acts on replies, bounces and stops. Filled in by the sync task; until then the 15-minute cron does nothing. */
export async function syncAllMailboxes(_env: Env): Promise<void> {}
