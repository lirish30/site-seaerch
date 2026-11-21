import type { Env } from "../env";

/** A site's inventory job ended (read, failed or expired). Task 7 fills this in: it decides whether the batch can move on. */
export async function onInventoryDone(_env: Env, _batchId: string): Promise<void> {}
