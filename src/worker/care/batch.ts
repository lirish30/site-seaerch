import type { Env } from "../env";

/** A site's inventory job ended (read, failed or expired). Task 7 fills this in: it decides whether the batch can move on. */
export async function onInventoryDone(_env: Env, _batchId: string): Promise<void> {}

/** A site's update run ended (applied, failed, dropped or expired). Task 7 fills this in: it decides whether the batch can move to its next wave. Safe to call twice for the same run. */
export async function onRunDone(_env: Env, _batchId: string): Promise<void> {}
