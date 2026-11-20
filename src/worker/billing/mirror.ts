import { getDocument } from "../db/documents";
import { insertMirroredInvoice, type InvoiceRow } from "../db/invoices";
import { getPackage } from "../db/packages";
import { getSettings } from "../db/settings";
import { getSubscription, getSubscriptionByStripeId, markSubscription, type SubscriptionStatus } from "../db/subscriptions";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { addMonths, calendarDateIn } from "./dates";

/** A Stripe id that arrives as a bare string or as an expanded object. */
const idOf = (v: unknown): string | null => (typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id ? (v as { id: string }).id : null);
const wholeCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const dateOf = (seconds: unknown, tz: string): string | null => (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? calendarDateIn(new Date(seconds * 1000), tz) : null);

/**
 * A Stripe invoice that a subscription made (the monthly charge) has no row here: Stripe made it, not an approval. This makes the row, once, so the money is counted and a failure is seen.
 * It matches the invoice's `subscription` to a local subscription and returns the row (new or already there), or null for an unknown subscription or an invoice of no money (a trial's first
 * invoice). The amount is what Stripe says was paid (for a paid event) or is due; on a failure `failed_on` is today in the owner's zone. Safe to run again: the row's ref is `stripe:<invoice id>`.
 */
export async function mirrorSubscriptionInvoice(env: Env, obj: Record<string, any>, type: string, now: Date = new Date()): Promise<InvoiceRow | null> {
  // No Stripe-Version is pinned, so the subscription is read from either payload shape: the older `subscription` and `subscription_details`, or the newer `parent.subscription_details`.
  const details = obj?.parent?.subscription_details;
  const stripeInvoiceId = idOf(obj?.id), stripeSubscriptionId = idOf(obj?.subscription) ?? idOf(details?.subscription);
  if (!stripeInvoiceId || !stripeSubscriptionId) return null;
  let sub = await getSubscriptionByStripeId(env.DB, stripeSubscriptionId);
  if (!sub) {
    // Stripe does not order events: a first invoice can arrive before checkout.session.completed has stored the Stripe subscription. The subscription's own metadata (set when its Checkout was made)
    // names ours. It is taken only when ours has no Stripe subscription yet, or this one, and a live event never lands on a test subscription. The invoice never activates it: only the Checkout does.
    const meta = obj?.subscription_details?.metadata ?? details?.metadata;
    const ours = typeof meta?.subscription_id === "string" && meta.subscription_id ? await getSubscription(env.DB, meta.subscription_id) : null;
    if (!ours || (ours.stripeSubscriptionId !== null && ours.stripeSubscriptionId !== stripeSubscriptionId) || (ours.test && obj.livemode === true)) return null;
    sub = ours;
  }
  const cents = type === "invoice.paid" ? obj.amount_paid : obj.amount_due;
  if (!wholeCents(cents)) return null;
  const settings = await getSettings(env.DB);
  const tz = zoneOf(settings);
  const doc = await getDocument(env.DB, sub.documentId);
  const pkg = await getPackage(env.DB, sub.packageKey, sub.packageVersion);
  const description = `${pkg?.name ?? "Subscription"}: monthly`;
  const hosted = typeof obj.hosted_invoice_url === "string" && obj.hosted_invoice_url.startsWith("https://") ? obj.hosted_invoice_url : null;
  const { invoice } = await insertMirroredInvoice(env.DB, {
    businessId: sub.businessId, dealId: doc?.dealId ?? null, documentId: sub.documentId, projectId: sub.projectId, subscriptionId: sub.id, kind: "subscription",
    ref: `stripe:${stripeInvoiceId}`, test: sub.test, description, lines: [{ description, amountCents: cents }], stripeCustomerId: idOf(obj.customer) ?? sub.stripeCustomerId,
    stripeInvoiceId, hostedUrl: hosted, dueOn: dateOf(obj.due_date, tz), failedOn: type === "invoice.payment_failed" ? calendarDateIn(now, tz) : null, now: now.toISOString(),
  });
  return invoice;
}

/** Subscriptions that have not started yet: a completed Checkout may start them. */
const NOT_STARTED: SubscriptionStatus[] = ["planned", "proposed", "link_sent"];

/**
 * The client finished Checkout for a subscription: it becomes `active`, with its Stripe subscription and customer, the time, and the end of the term (the first charge date plus the term's months).
 * Only a completed `mode: subscription` session that is paid or needs no payment yet (a trial) counts, for the Checkout the link made (the stored session, when there is one), and never a
 * live session for a test subscription or a Stripe subscription that another row holds. Idempotent: the move is guarded on the subscription not having started. True when it matched a subscription.
 */
export async function subscriptionCheckoutCompleted(env: Env, session: Record<string, any>, now: Date = new Date()): Promise<boolean> {
  if (!session || session.mode !== "subscription" || session.status !== "complete") return false;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return false;
  const ref = typeof session.client_reference_id === "string" ? session.client_reference_id : "";
  const stripeSubscriptionId = idOf(session.subscription);
  if (!ref || !stripeSubscriptionId) return false;
  const sub = await getSubscription(env.DB, ref);
  if (!sub) return false;
  if (sub.stripeCheckoutSessionId && sub.stripeCheckoutSessionId !== session.id) return false;
  if (sub.test && session.livemode === true) return false;
  const holder = await getSubscriptionByStripeId(env.DB, stripeSubscriptionId);
  if (holder && holder.id !== sub.id) return false;
  if (!NOT_STARTED.includes(sub.status)) return true; // already active (or finished): a replay changes nothing
  await markSubscription(env.DB, sub.id, {
    status: "active", stripeSubscriptionId, stripeCustomerId: idOf(session.customer) ?? sub.stripeCustomerId ?? undefined, activatedAt: now.toISOString(),
    termEndsOn: sub.firstChargeOn && sub.termMonths ? addMonths(sub.firstChargeOn, sub.termMonths) : undefined,
  }, { from: NOT_STARTED });
  return true;
}

/** Stripe's subscription statuses and where each takes ours, with the states it may leave. An `ended` term and a `cancelled` one are never moved. */
const UPDATES: Record<string, { to: SubscriptionStatus; from: SubscriptionStatus[] }> = {
  past_due: { to: "past_due", from: ["active"] },
  active: { to: "active", from: ["past_due"] },
  canceled: { to: "cancelled", from: ["planned", "proposed", "link_sent", "active", "past_due"] },
};

/** Stripe changed or deleted a subscription (a deletion arrives as `canceled`). Idempotent. True when it matched a subscription Stripe's status moves. */
export async function subscriptionUpdated(env: Env, obj: Record<string, any>, now: Date = new Date()): Promise<boolean> {
  const id = idOf(obj?.id);
  const move = typeof obj?.status === "string" ? UPDATES[obj.status] : undefined;
  if (!id || !move) return false;
  const sub = await getSubscriptionByStripeId(env.DB, id);
  if (!sub) return false;
  await markSubscription(env.DB, sub.id, { status: move.to, ...(move.to === "cancelled" ? { cancelledAt: now.toISOString() } : {}) }, { from: move.from });
  return true;
}
