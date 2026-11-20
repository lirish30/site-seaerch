import { listInvoices, type InvoiceRow } from "../db/invoices";
import { getDocument } from "../db/documents";
import { stripeFetch } from "../documents/deposit";
import type { Env } from "../env";
import { retrieveInvoice, stripeMode } from "../stripe/client";
import { handleStripeEvent, type StripeEvent } from "../stripe/webhook";
import { reconcileMilestones } from "./milestones";
import { onAnyInvoicePaid } from "./paid";
import { sweepReminders } from "./reminders";
import { sweepHolds } from "./hold";
import { planSubscriptions, startDueSubscriptions } from "./subscriptions";
import { sweepTerms } from "./terms";

/** An open invoice is not asked about at Stripe until it is this old: the webhook is the normal way to hear of a payment, this is the fallback for one that never came. */
const SETTLE_AFTER_MS = 24 * 60 * 60_000;

export interface BillingSweepResult { drafted: number; reminders: number; holds: number; started: number; converted: number; notices: number; planned: number }

const msg = (e: unknown, key: string | undefined) => {
  const raw = e instanceof Error ? e.message : "unknown error";
  return (key ? raw.split(key).join("[key]") : raw).replace(/\s+/g, " ").trim().slice(0, 200);
};

/** What an event of each Stripe invoice status is, for the three states an unpaid invoice can leave `open` for. */
const EVENT_FOR_STATUS: Record<string, string> = { paid: "invoice.paid", void: "invoice.voided", uncollectible: "invoice.marked_uncollectible" };

/**
 * The signed, paid, real documents that have no subscription row at all. `onInvoicePaid` plans them when the deposit is paid, but a failure there is never replayed, so the sweep makes the same
 * plan (one row per document and package, so a document that is planned is never planned twice). A document whose frozen schedule sells nothing recurring is not looked at.
 */
async function undeclaredDocuments(db: D1Database): Promise<string[]> {
  const rows = (await db.prepare(
    `SELECT d.id FROM documents d
      WHERE d.status = 'signed' AND d.test = 0 AND d.paid_at IS NOT NULL
        AND json_array_length(json_extract(d.content, '$.schedule.recurring')) > 0
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.document_id = d.id)
      ORDER BY d.created_at, d.id`,
  ).all<{ id: string }>()).results;
  return rows.map((r) => r.id);
}

async function planMissing(env: Env): Promise<number> {
  let planned = 0;
  for (const id of await undeclaredDocuments(env.DB)) {
    try {
      const doc = await getDocument(env.DB, id);
      if (doc) planned += await planSubscriptions(env, doc);
    } catch (e) { console.error("billing sweep: could not plan the subscriptions of a document", id, msg(e, env.STRIPE_SECRET_KEY)); }
  }
  return planned;
}

/** The event this invoice would have been told about, built from what Stripe says now. The ref and document are our own row's, as the deposit's own settle step passes them. */
function eventFor(inv: InvoiceRow, s: Awaited<ReturnType<typeof retrieveInvoice>>): StripeEvent | null {
  const type = EVENT_FOR_STATUS[s.status];
  if (!type) return null;
  return {
    // One id per invoice and outcome: a second sweep, or a webhook that does arrive, finds it already handled. An event that failed half way is released, so the next sweep tries again.
    id: `settle:${inv.id}:${s.status}`, type,
    data: { object: { id: s.id, object: "invoice", amount_paid: s.amountPaid, currency: s.currency, metadata: { ref: inv.ref, kind: inv.kind, document_id: inv.documentId ?? undefined } } },
  };
}

/**
 * Brings up to date the invoices whose webhook never came: every open or failed invoice that was sent more than a day ago is asked about at Stripe (a read, never a write), and one that was paid,
 * voided or written off there is handled by the very same code the webhook runs (`handleStripeEvent`): the amount, currency and ref are checked for a payment, the paid path (`onAnyInvoicePaid`)
 * runs, and a void or write-off lifts the hold. A live key never touches a test copy. Without a Stripe key, or with Stripe down, nothing changes (it is logged). Returns how many it settled.
 */
async function settleStale(env: Env, now: Date): Promise<number> {
  const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
  if (!key || !mode) return 0;
  let settled = 0;
  for (const inv of await listInvoices(env.DB, { statuses: ["open", "failed"] })) {
    if (!inv.stripeInvoiceId || (mode === "live" && inv.test)) continue;
    const since = Date.parse(inv.sentAt ?? inv.createdAt);
    if (!Number.isFinite(since) || now.getTime() - since < SETTLE_AFTER_MS) continue;
    try {
      const event = eventFor(inv, await retrieveInvoice(stripeFetch({}), key, inv.stripeInvoiceId));
      if (!event) continue; // still open there too
      if ((await handleStripeEvent(env, event, { onPaid: onAnyInvoicePaid, now: () => now, clock: () => now })) === "applied") settled++;
    } catch (e) { console.error("billing sweep: could not settle an invoice with Stripe", inv.id, msg(e, key)); }
  }
  return settled;
}

/** One part of the sweep, contained: its failure is logged and counts as nothing done, and never stops another part. */
async function part<T>(name: string, fallback: T, run: () => Promise<T>, key: string | undefined): Promise<T> {
  try { return await run(); }
  catch (e) { console.error(`billing sweep: ${name} failed`, msg(e, key)); return fallback; }
}

/**
 * The daily billing run (the cron reaches it through `runScheduled`). In order, each part contained and logged so one failing never stops another: the milestone invoices a hook never made are
 * drafted and proposed, the subscriptions nobody planned are planned, the due subscriptions are proposed, the reminders and pause holds that are due are drafted and placed, the terms that end
 * soon are noticed or converted, and the stale open invoices are settled from Stripe. It sends no mail and makes nothing at Stripe: it creates approvals and holds (and the draft invoices and
 * planned rows they hang off), and every step is idempotent, so a second run at the same moment adds nothing.
 */
export async function sweepBilling(env: Env, now: Date): Promise<BillingSweepResult> {
  const key = env.STRIPE_SECRET_KEY;
  const drafted = await part("milestone invoices", 0, () => reconcileMilestones(env), key);
  const planned = await part("subscription planning", 0, () => planMissing(env), key);
  const started = await part("subscription starts", 0, () => startDueSubscriptions(env, now), key);
  const reminders = await part("reminders", 0, () => sweepReminders(env, now), key);
  const holds = await part("holds", 0, () => sweepHolds(env, now), key);
  const terms = await part("terms", { notices: 0, converted: 0 }, () => sweepTerms(env, now), key);
  await part("settling open invoices", 0, () => settleStale(env, now), key);
  return { drafted, reminders, holds, started, converted: terms.converted, notices: terms.notices, planned };
}
