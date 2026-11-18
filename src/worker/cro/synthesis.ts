import type { Env } from "../env";

/**
 * Hands a finished set of page reviews over to the roadmap stage. Called by the page task once the last page is in (or skipped), possibly more
 * than once for the same audit (a crash-retry), so it must be idempotent. Nothing queues the roadmap yet: it stays here until the synthesis
 * stage moves onto the queue.
 */
export async function startSynthesis(_env: Env, _auditId: string): Promise<void> {}
