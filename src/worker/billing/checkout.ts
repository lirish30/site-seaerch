import { getBusiness } from "../db/businesses";
import { getDocument } from "../db/documents";
import { getSubscription, getSubscriptionByToken, markSubscription, type Subscription } from "../db/subscriptions";
import { stripeFetch } from "../documents/deposit";
import { clientBase } from "../documents/mail";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import type { Fetch } from "../google/oauth";
import { StripeError, chargedAtCheckout, createSubscriptionCheckout, ensureProduct, retrieveCheckoutSession, stripeMode } from "../stripe/client";
import { ensureStripeCustomer } from "./customer";
import { invoiceRecipient, subscriptionPlanName } from "./mail";
import { subscriptionCheckoutCompleted } from "./mirror";

/** What the client's subscription page shows. Never an id, a token, the owner's notes or anything about another client. */
export interface PublicSubscription {
  clientName: string;
  planName: string;
  monthlyCents: number;
  /** The date of the first payment (a calendar date), or null when none is set. */
  firstChargeOn: string | null;
  /** True when the card is charged at Checkout (no first charge date, or one under 3 days away): the page says "charged today" then, whatever `firstChargeOn` holds. */
  chargedNow: boolean;
  termMonths: number | null;
  /** `ready` can start Checkout, `active` is set up and running, `closed` is over (cancelled or ended). */
  state: "ready" | "active" | "closed";
}

export type CheckoutResult = { url: string } | { error: "closed" | "unavailable" };
type Deps = { fetch?: Fetch; now?: Date };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** A reason that is safe to log: one line, never the secret key, never long. */
const safe = (e: unknown, key: string | undefined): string => {
  const raw = e instanceof Error ? e.message : "unknown error";
  return oneLine(key ? raw.split(key).join("[key]") : raw).slice(0, 200);
};

/**
 * The subscription behind a link, or null: not a token, unknown, or not live yet (a planned or merely proposed one has no link). The same answer for all of them, so a stranger learns
 * nothing about which links exist. A test subscription is served like a real one: it is the owner's rehearsal.
 */
export async function findSubscription(env: Env, token: string): Promise<Subscription | null> {
  if (!isClientToken(token)) return null;
  const sub = await getSubscriptionByToken(env.DB, token);
  return !sub || !sub.token || sub.status === "planned" || sub.status === "proposed" ? null : sub;
}

/**
 * Brings a `link_sent` subscription up to date with Stripe when it has a Checkout on record, so a webhook that never arrived still resolves: the stored session is read back and, when it is
 * complete and paid (or needs no payment yet), the subscription is activated through the same function the webhook uses (which checks the session id against the stored one again). Only
 * the stored session is ever asked about, never anything from the query string. Stripe being unreachable is not an error: the row comes back as it was. A live key never reads a test row.
 */
async function settle(env: Env, sub: Subscription, f: Fetch, now: Date): Promise<Subscription> {
  const sessionId = sub.stripeCheckoutSessionId;
  if (sub.status !== "link_sent" || !sessionId) return sub;
  const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
  if (!key || !mode || (sub.test && mode === "live")) return sub;
  try {
    const s = await retrieveCheckoutSession(f, key, sessionId);
    if (s.id !== sessionId || s.status !== "complete" || !s.subscriptionId) return sub;
    await subscriptionCheckoutCompleted(env, {
      id: s.id, mode: "subscription", status: s.status, payment_status: s.paymentStatus, client_reference_id: sub.id, subscription: s.subscriptionId, customer: s.customerId, livemode: mode === "live",
    }, now);
  } catch (e) {
    console.error("subscription: could not bring the checkout up to date", safe(e, key));
  }
  return (await getSubscription(env.DB, sub.id)) ?? sub;
}

/**
 * What the client's page shows for a link: its state comes from the database (a `link_sent` one with a Checkout on record is first checked with Stripe), never from the query string, so
 * `?done=1` on a Checkout that was not finished still reads `ready`. Null for a link that is not live.
 */
export async function subscriptionPage(env: Env, token: string, deps: Deps = {}): Promise<PublicSubscription | null> {
  const found = await findSubscription(env, token);
  if (!found) return null;
  const now = deps.now ?? new Date();
  const sub = await settle(env, found, stripeFetch(deps), now);
  const doc = await getDocument(env.DB, sub.documentId);
  const clientName = oneLine(doc?.content.header.clientName || (await getBusiness(env.DB, sub.businessId))?.name || "");
  return {
    clientName, planName: await subscriptionPlanName(env, sub), monthlyCents: sub.monthlyCents, firstChargeOn: sub.firstChargeOn, chargedNow: chargedAtCheckout(sub.firstChargeOn, now.getTime()), termMonths: sub.termMonths,
    state: sub.status === "link_sent" ? "ready" : sub.status === "active" || sub.status === "past_due" ? "active" : "closed",
  };
}

/**
 * The client's click on "Set up payment": a Stripe Checkout page for this subscription. Makes the customer and the product (each once, by its idempotency key), then a Checkout session whose
 * key is `checkout:<id>:<UTC date>`, and stores the session's id on the subscription BEFORE the url is given out: the webhook and the page both activate only for the stored session. A subscription that is active, past
 * due, cancelled or ended is refused (`closed`), and so is one whose stored Checkout is complete (paid, or a bank debit still clearing). A stored Checkout that is still open is returned
 * again, not replaced; only an expired (or unknown) one is replaced by a new session, so there is never more than one Checkout a client can pay: a second would make a second subscription. `unavailable` when Stripe is
 * not set up, the client link base is not https, a live key would touch a test subscription, or Stripe fails.
 */
export async function startCheckout(env: Env, token: string, deps: Deps = {}): Promise<CheckoutResult> {
  const found = await findSubscription(env, token);
  if (!found) return { error: "closed" };
  const f = stripeFetch(deps), now = deps.now ?? new Date();
  const sub = await settle(env, found, f, now);
  if (sub.status !== "link_sent") return { error: "closed" };

  const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
  if (!key || !mode) return { error: "unavailable" };
  if (sub.test && mode === "live") return { error: "unavailable" };
  const base = clientBase(env);
  if (!base || !base.startsWith("https://")) return { error: "unavailable" };

  try {
    // One Checkout at a time: a second session beside an open one could be paid as well, and only the stored one activates anything. So the stored session decides first.
    if (sub.stripeCheckoutSessionId) {
      let stored: Awaited<ReturnType<typeof retrieveCheckoutSession>> | null = null;
      try { stored = await retrieveCheckoutSession(f, key, sub.stripeCheckoutSessionId); }
      catch (e) { if (!(e instanceof StripeError && e.status === 404)) throw e; } // Stripe does not know it any more: there is nothing open, so a new one is made
      // Complete is paid or still clearing (a bank debit is complete while unpaid): never a second Checkout. Open is still the client's to finish: the same page again.
      if (stored?.status === "complete") return { error: "closed" };
      if (stored?.status === "open") return stored.url ? { url: stored.url } : { error: "unavailable" };
    }
    const who = await invoiceRecipient(env, sub);
    const customerId = await ensureStripeCustomer(env, { businessId: sub.businessId, name: who.clientName, email: who.to }, f);
    const plan = await subscriptionPlanName(env, sub);
    const product = await ensureProduct(f, key, { packageKey: sub.packageKey, name: plan }, `product:${sub.packageKey}`);
    const session = await createSubscriptionCheckout(f, key, {
      customerId, productId: product.id, name: plan, monthlyCents: sub.monthlyCents, firstChargeOn: sub.firstChargeOn, subscriptionId: sub.id, businessId: sub.businessId,
      successUrl: `${base}/s/${token}?done=1`, cancelUrl: `${base}/s/${token}`, nowMs: now.getTime(),
    }, `checkout:${sub.id}:${now.toISOString().slice(0, 10)}:2`); // `:2`: the first form of this request was refused by Stripe, and Stripe keeps a key for 24 hours against its first parameters
    // Stored before the url leaves: a Checkout the app does not know of could be paid and never activate anything.
    const stored = await markSubscription(env.DB, sub.id, { stripeCheckoutSessionId: session.sessionId, stripeCustomerId: customerId }, { from: ["link_sent"] });
    if (!stored) return { error: "closed" }; // it was activated or cancelled while the session was being made
    return { url: session.url };
  } catch (e) {
    console.error("subscription: checkout not started", safe(e, key));
    return { error: "unavailable" };
  }
}
