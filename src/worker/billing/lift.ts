import { liftHoldsForInvoice } from "../db/holds";
import type { Env } from "../env";
import { dispatchReady } from "../projects/dispatch";

/**
 * An invoice can no longer be paid (voided, or written off as uncollectible): its hold, if any, is lifted, and the Claude steps that were waiting on it are sent now rather than at the next
 * daily project sweep. Dispatching is best effort (the lift is already recorded, and the sweep dispatches too), so a failure is logged and never fails the event or the void that called this.
 * Safe to repeat. Returns how many holds this call lifted.
 */
export async function liftHoldOfDeadInvoice(env: Env, invoiceId: string, now: Date): Promise<number> {
  const lifted = await liftHoldsForInvoice(env.DB, invoiceId, "void", now.toISOString());
  try { await dispatchReady(env, now); }
  catch (e) { console.error("billing: could not dispatch after an invoice stopped holding work", e instanceof Error ? e.message : "unknown error"); }
  return lifted;
}
