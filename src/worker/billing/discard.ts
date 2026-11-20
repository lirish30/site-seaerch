import { getInvoice, markInvoice, discardDraftInvoice, type InvoiceRow } from "../db/invoices";
import { liftHoldsForInvoice } from "../db/holds";
import { releaseTimeEntries } from "../db/time";
import { stripeFetch } from "../documents/deposit";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { stripeMode, voidInvoice } from "../stripe/client";
import { SEND_KIND } from "./draft";

async function need(env: Env, id: string): Promise<InvoiceRow> {
  const inv = await getInvoice(env.DB, id);
  if (!inv) throw new Error("There is no such invoice.");
  return inv;
}

/** Marks the invoice's waiting send approval rejected: what it said is no longer to be sent. */
const withdrawSend = (db: D1Database, invoiceId: string, note: string) =>
  db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decision_note = ? WHERE kind = ? AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`)
    .bind(getMailDeps().now().toISOString(), note, SEND_KIND, invoiceId).run();

/**
 * Throws a draft invoice away: it becomes void, its waiting `invoice.send` approval is rejected and the time entries it billed are released. Nothing exists at Stripe for a draft. A paid
 * invoice, or one that was sent, is refused with a plain sentence (a sent one is voided with `voidSentInvoice`). Repeating it on a discarded draft repairs a discard that died half-way.
 */
export async function discardInvoice(env: Env, id: string): Promise<InvoiceRow> {
  const db = env.DB;
  let inv = await need(env, id);
  if (inv.status === "paid") throw new Error("This invoice is paid, so it cannot be discarded.");
  const discarded = inv.status === "void" && inv.stripeInvoiceId === null;
  if (inv.status !== "draft" && !discarded) throw new Error(`This invoice is ${inv.status} and was sent, so it is voided, not discarded.`);
  if (inv.status === "draft" && !(await discardDraftInvoice(db, id))) {
    // It was approved (or discarded) between the read and the write: say what it is now.
    inv = await need(env, id);
    if (inv.status === "paid") throw new Error("This invoice is paid, so it cannot be discarded.");
    if (inv.status !== "void" || inv.stripeInvoiceId !== null) throw new Error(`This invoice is ${inv.status} and was sent, so it is voided, not discarded.`);
  }
  await withdrawSend(db, id, "the invoice was discarded");
  await releaseTimeEntries(db, inv.ref);
  return need(env, id);
}

/**
 * Cancels an invoice that was sent and not paid (open or failed): Stripe voids it (one idempotency key per invoice, so a retry replays), then the row becomes void, the time entries it
 * billed are released and its hold, if any, is lifted. A paid invoice is refused with a plain sentence, and a draft is not voided (it is discarded). A Stripe failure changes nothing here,
 * so the same call can be made again. Repeating it on a void invoice repairs a void that died half-way, without calling Stripe again.
 */
export async function voidSentInvoice(env: Env, id: string): Promise<InvoiceRow> {
  const db = env.DB;
  let inv = await need(env, id);
  if (inv.status === "paid") throw new Error("This invoice is paid, so it cannot be voided.");
  if (inv.status === "draft") throw new Error("This invoice is a draft that was never sent: discard it instead.");
  if (inv.status === "void" && inv.stripeInvoiceId === null) throw new Error("This invoice was a draft that was discarded, not sent.");
  if (inv.status === "uncollectible") throw new Error("This invoice is uncollectible, so it cannot be voided.");
  if (inv.status === "open" || inv.status === "failed") {
    if (!inv.stripeInvoiceId) throw new Error("This invoice has no Stripe invoice to void.");
    const key = env.STRIPE_SECRET_KEY;
    const mode = stripeMode(key);
    if (!key || !mode) throw new Error("Stripe is not set up: add the Stripe secret key first, then void this again.");
    if (mode === "live" && inv.test) throw new Error("This is a test invoice and Stripe is in live mode, so it cannot be voided here. Switch Stripe to the test key first.");
    await voidInvoice(stripeFetch({}), key, inv.stripeInvoiceId);
    if (!(await markInvoice(db, id, { status: "void" }, { notFrom: ["paid"] }))) {
      inv = await need(env, id);
      if (inv.status === "paid") throw new Error("This invoice is paid, so it cannot be voided.");
    }
  }
  await releaseTimeEntries(db, inv.ref);
  await liftHoldsForInvoice(db, id, "void", getMailDeps().now().toISOString());
  return need(env, id);
}
