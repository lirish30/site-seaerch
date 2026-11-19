import type { Env } from "../env";
import { requestCallPrep } from "../queue/callPrep";

/**
 * Queues the call-prep task for a deal once its discovery call is booked: Claude tailors Logan's prep for the call (see `queue/callPrep.ts`). The
 * booking path calls this and nothing else. One open prep per deal, so asking twice queues one task.
 */
export async function queueCallPrep(env: Env, dealId: string): Promise<void> {
  await requestCallPrep(env.DB, dealId);
}
