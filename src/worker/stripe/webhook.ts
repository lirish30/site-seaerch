import { mirrorSubscriptionInvoice, subscriptionCheckoutCompleted, subscriptionUpdated } from "../billing/mirror";
import { calendarDateIn } from "../billing/dates";
import { liftHoldsForInvoice } from "../db/holds";
import { claimEvent, finishEvent, getInvoiceByStripeId, markInvoice, releaseEvent, type InvoiceRow, type InvoiceStatus } from "../db/invoices";
import { getSettings } from "../db/settings";
import { markSubscription } from "../db/subscriptions";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";

const enc = new TextEncoder();
export const SIGNATURE_TOLERANCE_SEC = 300;
const HEX64 = /^[0-9a-f]{64}$/i;

const hexBytes = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

/**
 * Stripe-Signature is `t=<unix>,v1=<hex>[,v1=<hex>...]`; v1 is an HMAC-SHA256 of `${t}.${rawBody}` under the endpoint secret.
 * Fails closed: an empty secret, a missing or malformed header, a repeated timestamp, a timestamp more than `toleranceSec` from now (either way) or no matching v1.
 * The comparison is WebCrypto's own verify, which is constant-time.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec: number, toleranceSec = SIGNATURE_TOLERANCE_SEC): Promise<boolean> {
  if (!header || !secret) return false;
  const ts: string[] = [], sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") ts.push(v); else if (k === "v1") sigs.push(v);
  }
  if (ts.length !== 1 || !/^\d{1,15}$/.test(ts[0]) || sigs.length === 0) return false;
  const t = Number(ts[0]);
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = enc.encode(`${ts[0]}.${rawBody}`);
  let ok = false;
  for (const s of sigs) {
    if (!HEX64.test(s)) continue;
    // No early exit: every candidate is checked.
    if (await crypto.subtle.verify("HMAC", key, hexBytes(s), signed)) ok = true;
  }
  return ok;
}

/** The part of a Stripe event this app reads. */
export interface StripeEvent { id: string; type: string; data: { object: Record<string, any> } }
/** `busy`: another delivery of this event is being handled right now; the route answers 503 so Stripe tries again later. */
export type StripeResult = "applied" | "duplicate" | "ignored" | "mismatch" | "busy";

const MAX_NOTE = 200;
const str = (v: unknown): string => String(v ?? "").slice(0, 40);

/**
 * What an invoice.paid says that we do not agree with, or null when it matches: the amount paid is exactly the cents we invoiced, in dollars, and the invoice is the one
 * we made. A deposit is matched on its document (the metadata we set when creating it); every other kind on its own ref, which the document alone cannot tell from its siblings.
 * An invoice Stripe made for a subscription carries none of our metadata: its ref is its own Stripe id.
 */
export function paidProblem(inv: InvoiceRow, obj: Record<string, any>): string | null {
  const problems: string[] = [];
  if (obj.amount_paid !== inv.amountCents) problems.push(`amount paid ${str(obj.amount_paid)} is not the ${inv.amountCents} invoiced`);
  if (obj.currency !== "usd") problems.push(`currency ${str(obj.currency)} is not usd`);
  const meta = obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {};
  if (inv.kind === "deposit") {
    if (meta.document_id !== inv.documentId) problems.push(`document ${str(meta.document_id)} is not the invoiced one`);
  } else {
    const ref = inv.kind === "subscription" && inv.ref.startsWith("stripe:") ? `stripe:${String(obj.id ?? "")}` : meta.ref;
    if (ref !== inv.ref) problems.push(`ref ${str(ref)} is not the invoiced one`);
  }
  return problems.length ? problems.join("; ").slice(0, MAX_NOTE) : null;
}

/** Where each event type takes an invoice, and the states it may not take it out of (a late or replayed event never undoes a payment or a void). */
const MOVES: Record<string, { to: InvoiceStatus; notFrom: InvoiceStatus[] }> = {
  "invoice.voided": { to: "void", notFrom: ["paid"] },
  "invoice.marked_uncollectible": { to: "uncollectible", notFrom: ["paid", "void"] },
  "invoice.payment_failed": { to: "failed", notFrom: ["paid", "void", "uncollectible"] },
};

/** Events about an invoice: `invoice.paid` is checked against the amount (below), the rest move the row. */
const INVOICE_EVENTS = new Set(["invoice.paid", ...Object.keys(MOVES)]);

async function applyInvoice(env: Env, event: StripeEvent, deps: StripeDeps, now: Date): Promise<StripeResult> {
  const obj = event.data?.object;
  if (!obj || typeof obj.id !== "string") return "ignored";
  const isPaid = event.type === "invoice.paid";
  // Another product on the same Stripe account, or an invoice we did not make: ignored, unless it is a month of one of our subscriptions, which Stripe made itself.
  const inv = (await getInvoiceByStripeId(env.DB, obj.id)) ?? (await mirrorSubscriptionInvoice(env, obj, event.type, now));
  if (!inv) return "ignored";

  if (!isPaid) {
    const move = MOVES[event.type];
    // A failed autopay month is dated (the date the reminders and the pause count from) and puts its subscription past due.
    const autopay = inv.kind === "subscription";
    const failedOn = autopay && event.type === "invoice.payment_failed" ? calendarDateIn(now, zoneOf(await getSettings(env.DB))) : undefined;
    if (!(await markInvoice(env.DB, inv.id, { status: move.to, failedOn }, { notFrom: move.notFrom, failedOnOnce: true }))) return "ignored";
    if (autopay && inv.subscriptionId && event.type === "invoice.payment_failed") await markSubscription(env.DB, inv.subscriptionId, { status: "past_due" }, { from: ["active"] });
    // A voided invoice can no longer be paid, so it holds nobody's work back.
    if (event.type === "invoice.voided") await liftHoldsForInvoice(env.DB, inv.id, "void", now.toISOString());
    return "applied";
  }

  const problem = paidProblem(inv, obj);
  if (problem) {
    // Guarded like the moves: a note never lands on an invoice that is already paid or void.
    await markInvoice(env.DB, inv.id, { mismatch: problem }, { notFrom: ["paid", "void"] });
    return "mismatch";
  }
  // A retry after a failed onPaid keeps the first paid time.
  await markInvoice(env.DB, inv.id, { status: "paid", paidAt: inv.paidAt ?? new Date().toISOString(), mismatch: null });
  // onPaid runs for every paid event that is not a duplicate, including the retry of one whose onPaid threw: it must be safe to run twice.
  if (deps.onPaid) await deps.onPaid(env, (await getInvoiceByStripeId(env.DB, obj.id))!);
  return "applied";
}

async function apply(env: Env, event: StripeEvent, deps: StripeDeps, now: Date): Promise<StripeResult> {
  if (INVOICE_EVENTS.has(event.type)) return applyInvoice(env, event, deps, now);
  const obj = event.data?.object;
  if (!obj || typeof obj !== "object") return "ignored";
  if (event.type === "checkout.session.completed") return (await subscriptionCheckoutCompleted(env, obj, now)) ? "applied" : "ignored";
  if (event.type === "customer.subscription.updated") return (await subscriptionUpdated(env, obj, now)) ? "applied" : "ignored";
  // A deleted subscription arrives with the status it ended in; it is cancelled whatever that says.
  if (event.type === "customer.subscription.deleted") return (await subscriptionUpdated(env, { ...obj, status: "canceled" }, now)) ? "applied" : "ignored";
  return "ignored";
}

export interface StripeDeps { onPaid?: (env: Env, inv: InvoiceRow) => Promise<void>; /** The clock, for the event lease. */ now?: () => Date; /** The clock the handlers date their work by (a failure's `failed_on`); the real time unless a test hands one in. */ clock?: () => Date }

/**
 * Handles one verified event, claiming it first: the id is inserted with no processed time, and only the caller that holds the claim applies it.
 * Another delivery of an event that is finished is a `duplicate`, and of one whose claim is under 2 minutes old a `busy` (the route answers 503).
 * An unfinished claim older than that (the Worker died, or the release below failed) is taken over, so an event is never lost as "processed".
 * The event is marked processed only after the state update and onPaid have succeeded. On any failure the claim is released (dated to the epoch) and the
 * error rethrown, which the route turns into a 500; the retry re-claims at once. onPaid can therefore run again for the same event: it must be idempotent.
 */
export async function handleStripeEvent(env: Env, event: StripeEvent, deps: StripeDeps = {}): Promise<StripeResult> {
  const now = deps.now ?? (() => new Date());
  const claim = await claimEvent(env.DB, event.id, event.type, now());
  if (claim !== "claimed") return claim;
  try {
    const result = await apply(env, event, deps, (deps.clock ?? (() => new Date()))());
    await finishEvent(env.DB, event.id, now());
    return result;
  } catch (e) {
    // Never delete the row: a failed release only means the next delivery waits for the lease. Log the id, not the payload.
    await releaseEvent(env.DB, event.id).catch(() => console.error("stripe webhook: could not release the claim on event", event.id));
    throw e;
  }
}
