import { dollars } from "../../client/packagesView";
import { logActivityOnce } from "../db/activity";
import { liftHoldsForInvoice } from "../db/holds";
import type { InvoiceRow } from "../db/invoices";
import { markSubscription } from "../db/subscriptions";
import { markChangeOrderPaid, ChangeOrderStateError } from "../changeorders/service";
import { onInvoicePaid } from "../documents/deposit";
import type { Env } from "../env";
import { dispatchReady } from "../projects/dispatch";

/** A line in the lead's timeline never runs past this. */
const NOTE_MAX = 280;

async function changeOrderPaid(env: Env, inv: InvoiceRow, now: Date): Promise<void> {
  const note = (why: string) => logActivityOnce(env.DB, inv.businessId, "note", `${inv.description} ${dollars(inv.amountCents)} was paid (${inv.ref}) but ${why}: check it`.slice(0, NOTE_MAX));
  if (!inv.changeOrderId) { await note("the invoice has no change order"); return; }
  try { await markChangeOrderPaid(env, inv.changeOrderId, { via: "stripe", now }); }
  catch (e) {
    // A change order that is no longer signed (voided or expired after the invoice went out) cannot take the payment. The money is Logan's to look at, not an error to retry.
    if (!(e instanceof ChangeOrderStateError)) throw e;
    await note(`the change order cannot take it (${e.message.replace(/\s+/g, " ").trim().replace(/\.$/, "")})`);
  }
}

/**
 * The production `onPaid`, run when a Stripe invoice of any kind is paid (the amount, currency and ref were already checked). It can run more than once for one payment (the webhook
 * retries an event whose handling failed), so every step is safe to repeat. A deposit runs the deposit's own work; a change order is marked paid through Stripe, which unlocks its tasks;
 * every other kind logs `invoice_paid` once. Then for every kind: a subscription that had gone past due is active again, the invoice's hold (and no other) is lifted, and the Claude steps that
 * were waiting on the hold are dispatched.
 */
export async function onAnyInvoicePaid(env: Env, inv: InvoiceRow): Promise<void> {
  const now = new Date();
  if (inv.kind === "deposit") await onInvoicePaid(env, inv);
  else if (inv.kind === "change_order") await changeOrderPaid(env, inv, now);
  else await logActivityOnce(env.DB, inv.businessId, "invoice_paid", `${inv.description} ${dollars(inv.amountCents)} paid (${inv.ref})${inv.test ? ", test copy" : ""}`);
  if (inv.kind === "subscription" && inv.subscriptionId) await markSubscription(env.DB, inv.subscriptionId, { status: "active" }, { from: ["past_due"] });
  await liftHoldsForInvoice(env.DB, inv.id, "payment", now.toISOString());
  // The payment is recorded and the hold is lifted: handing work to Claude is best effort (the daily sweep dispatches too), so it never turns a paid invoice into a failed event.
  try { await dispatchReady(env, now); }
  catch (e) { console.error("billing: could not dispatch after a payment", e instanceof Error ? e.message : "unknown error"); }
}
