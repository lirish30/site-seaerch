import type { Fetch } from "../google/oauth";
import type { InvoiceKind } from "../db/invoices";

const API = "https://api.stripe.com";
const MAX_MESSAGE = 200;

/** "test" or "live" from a secret or restricted key's prefix; null for anything else (including a publishable key). */
export function stripeMode(key: string | undefined): "test" | "live" | null {
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

/**
 * Stripe's form encoding: nested objects as `a[b]`, arrays by index (`a[0]`), and `undefined` left out.
 * Brackets stay literal; every key part and value is percent-encoded. null is sent as an empty value, which is how Stripe unsets a field.
 */
export function encodeForm(o: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (name: string, v: unknown): void => {
    if (v === undefined) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${name}[${i}]`, x)); return; }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(`${name}[${encodeURIComponent(k)}]`, x);
      return;
    }
    out.push(`${name}=${v === null ? "" : encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(o)) walk(encodeURIComponent(k), v);
  return out.join("&");
}

/** A call to Stripe failed. The message is Stripe's own `error.message` (200 characters at most) and never contains the key. */
export class StripeError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "StripeError"; }
}

/** Longest a call to Stripe may take (the whole call, body included). */
const TIMEOUT_MS = 15_000;

const cap = (s: string, key: string): string => (key ? s.split(key).join("[key]") : s).slice(0, MAX_MESSAGE);

async function call<T>(f: Fetch, key: string, method: "GET" | "POST", path: string, form?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!stripeMode(key)) throw new StripeError("Stripe is not configured with a secret key", 0);
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  let body: string | undefined;
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    body = encodeForm(form ?? {});
  }
  let res: Response;
  try { res = await f(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) {
    // The cause is dropped: it is not ours to relay. A request that ran out of time says so (the signing response waits for this call).
    throw new StripeError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "Stripe did not respond" : "could not reach Stripe", 0);
  }
  const json = await res.json<any>().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message;
    throw new StripeError(typeof msg === "string" && msg ? cap(msg, key) : `Stripe answered ${res.status}`, res.status);
  }
  if (!json || typeof json !== "object") throw new StripeError("Stripe sent a reply that is not JSON", res.status);
  return json as T;
}

/** The id Stripe sent back for something it created. */
const idOf = (o: { id?: unknown }): string => {
  if (typeof o.id !== "string" || !o.id) throw new StripeError("Stripe's reply had no id", 0);
  return o.id;
};

export async function createCustomer(f: Fetch, key: string, o: { name: string; email: string; businessId: string }, idempotencyKey: string): Promise<{ id: string }> {
  const c = await call<{ id?: unknown }>(f, key, "POST", "/v1/customers", { name: o.name, email: o.email, metadata: { business_id: o.businessId } }, idempotencyKey);
  return { id: idOf(c) };
}

/** A whole, positive number of cents (what Stripe takes for an amount). */
const wholeCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Stripe's unix seconds as a UTC calendar date (`YYYY-MM-DD`), or null when it is not a time. */
const utcDate = (seconds: unknown): string | null =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;

/** The invoice flow shared by every kind. `extra` is metadata a caller adds beside ref, kind and business_id. */
async function invoiceFlow(
  f: Fetch, key: string,
  o: { customerId: string; lines: { description: string; amountCents: number }[]; daysUntilDue: number; ref: string; kind: string; businessId: string; documentId?: string; footer?: string },
  extra: Record<string, string>, idempotencyKey: string,
): Promise<{ invoiceId: string; hostedUrl: string; status: string; dueOn: string | null }> {
  if (!Array.isArray(o.lines) || o.lines.length === 0) throw new RangeError("an invoice needs at least one line");
  if (!o.lines.every((l) => wholeCents(l.amountCents))) throw new RangeError("an invoice is for a whole, positive number of cents");
  if (!Number.isSafeInteger(o.daysUntilDue) || o.daysUntilDue < 1) throw new RangeError("an invoice is due in a whole number of days, at least one");
  const inv = await call<{ id?: unknown }>(f, key, "POST", "/v1/invoices", {
    customer: o.customerId, currency: "usd", collection_method: "send_invoice", days_until_due: o.daysUntilDue, auto_advance: false,
    pending_invoice_items_behavior: "exclude", // the lines are attached by invoice id below, never swept in from the customer's pending items
    payment_settings: { payment_method_types: ["card", "us_bank_account"] },
    footer: o.footer || undefined,
    metadata: { ref: o.ref, kind: o.kind, business_id: o.businessId, document_id: o.documentId, ...extra },
  }, `${idempotencyKey}:invoice`);
  const invoiceId = idOf(inv);
  for (const [i, l] of o.lines.entries()) {
    await call(f, key, "POST", "/v1/invoiceitems", { invoice: invoiceId, customer: o.customerId, amount: l.amountCents, currency: "usd", description: l.description }, i === 0 ? `${idempotencyKey}:item` : `${idempotencyKey}:item:${i}`);
  }
  const fin = await call<{ status?: unknown; hosted_invoice_url?: unknown; due_date?: unknown }>(f, key, "POST", `/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`, { auto_advance: false }, `${idempotencyKey}:finalize`);
  // The link is mailed to a client: it must be Stripe's https page.
  if (typeof fin.hosted_invoice_url !== "string" || !fin.hosted_invoice_url.startsWith("https://")) throw new StripeError("Stripe did not return a hosted invoice link", 0);
  return { invoiceId, hostedUrl: fin.hosted_invoice_url, status: typeof fin.status === "string" ? fin.status : "open", dueOn: utcDate(fin.due_date) };
}

/**
 * An invoice sent by link (no automatic email or collection): create it, attach one item per line, finalize it. Each call has its own idempotency key
 * (`<key>:invoice`, `:item` and `:item:<n>` for later lines, `:finalize`), so repeating the whole call with the same base key after a partial failure replays what Stripe already did.
 */
export function createInvoice(
  f: Fetch, key: string,
  o: { customerId: string; lines: { description: string; amountCents: number }[]; daysUntilDue: number; ref: string; kind: InvoiceKind; businessId: string; documentId?: string; footer?: string },
  idempotencyKey: string,
): Promise<{ invoiceId: string; hostedUrl: string; status: string; dueOn: string | null }> {
  return invoiceFlow(f, key, o, {}, idempotencyKey);
}

/** The deposit: one line, due in seven days, with the deal id kept in metadata. */
export function createDepositInvoice(
  f: Fetch, key: string,
  o: { customerId: string; amountCents: number; description: string; documentId: string; dealId: string; businessId: string },
  idempotencyKey: string,
): Promise<{ invoiceId: string; hostedUrl: string; status: string }> {
  return invoiceFlow(f, key, {
    customerId: o.customerId, lines: [{ description: o.description, amountCents: o.amountCents }], daysUntilDue: 7,
    ref: `deposit:${o.documentId}`, kind: "deposit", businessId: o.businessId, documentId: o.documentId,
  }, { deal_id: o.dealId }, idempotencyKey).then(({ invoiceId, hostedUrl, status }) => ({ invoiceId, hostedUrl, status }));
}

/** Voids an open invoice. Voiding is final, and a repeat of the same call replays. */
export async function voidInvoice(f: Fetch, key: string, invoiceId: string): Promise<void> {
  await call(f, key, "POST", `/v1/invoices/${encodeURIComponent(invoiceId)}/void`, {}, `void:${invoiceId}`);
}

/** The Stripe product behind a care package, made once per package key (the idempotency key keeps a retry from making a second). */
export async function ensureProduct(f: Fetch, key: string, o: { packageKey: string; name: string }, idempotencyKey: string): Promise<{ id: string }> {
  const p = await call<{ id?: unknown }>(f, key, "POST", "/v1/products", { name: o.name, metadata: { package_key: o.packageKey } }, idempotencyKey);
  return { id: idOf(p) };
}

/** Noon UTC of a `YYYY-MM-DD` date as epoch milliseconds; null when the text is not a real calendar date. */
const noon = (day: string): number | null => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T12:00:00.000Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(day) ? t : null;
};
const DAY_MS = 86_400_000;
const monthlyPrice = (productId: string, monthlyCents: number) => ({ currency: "usd", product: productId, unit_amount: monthlyCents, recurring: { interval: "month" } });

/**
 * Whether the card is charged at Checkout rather than on a later date. The one rule behind both the Checkout request (no `trial_end`) and the words on the client's page: a first charge
 * 3 or more days away (noon UTC of that date, from `nowMs`) is a trial until then; none, or sooner, is charged at Checkout (Stripe wants a trial end at least 48 hours out).
 */
export function chargedAtCheckout(firstChargeOn: string | null, nowMs: number): boolean {
  const at = firstChargeOn === null ? null : noon(firstChargeOn);
  return at === null || at - nowMs < 3 * DAY_MS;
}

/**
 * A subscription Checkout page. The first charge is the day the plan starts: when that is 3 or more days off (Stripe wants a trial end at least
 * 48 hours out), the card is taken at Checkout and billed from then, through `trial_end` at noon UTC of that date.
 */
export async function createSubscriptionCheckout(
  f: Fetch, key: string,
  o: { customerId: string; productId: string; name: string; monthlyCents: number; firstChargeOn: string | null; subscriptionId: string; businessId: string; successUrl: string; cancelUrl: string; nowMs: number },
  idempotencyKey: string,
): Promise<{ sessionId: string; url: string }> {
  if (!wholeCents(o.monthlyCents)) throw new RangeError("a subscription is for a whole, positive number of cents a month");
  const at = o.firstChargeOn === null ? null : noon(o.firstChargeOn);
  if (o.firstChargeOn !== null && at === null) throw new RangeError("firstChargeOn is a YYYY-MM-DD date");
  const trialEnd = at !== null && !chargedAtCheckout(o.firstChargeOn, o.nowMs) ? Math.floor(at / 1000) : undefined;
  const s = await call<{ id?: unknown; url?: unknown }>(f, key, "POST", "/v1/checkout/sessions", {
    mode: "subscription", customer: o.customerId, client_reference_id: o.subscriptionId,
    payment_method_types: ["card"], // card only: an ACH debit settles days after Checkout and would leave the row waiting, so a subscription is never offered a bank account
    line_items: [{ quantity: 1, price_data: monthlyPrice(o.productId, o.monthlyCents) }],
    subscription_data: { description: o.name, trial_end: trialEnd, metadata: { subscription_id: o.subscriptionId, business_id: o.businessId } },
    success_url: o.successUrl, cancel_url: o.cancelUrl,
  }, idempotencyKey);
  // The link is sent to a client: it must be Stripe's https page.
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a Checkout link", 0);
  return { sessionId: idOf(s), url: s.url };
}

/** An id that Stripe may send as a bare string or as an expanded object. */
const refId = (v: unknown): string | null => (typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/** An open Checkout session carries the page's `url`; it is handed to a client, so only Stripe's https page counts (anything else is null). */
export async function retrieveCheckoutSession(f: Fetch, key: string, id: string): Promise<{ id: string; status: string; paymentStatus: string; subscriptionId: string | null; customerId: string | null; url: string | null }> {
  const s = await call<{ id?: unknown; status?: unknown; payment_status?: unknown; subscription?: unknown; customer?: unknown; url?: unknown }>(f, key, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
  return {
    id: idOf(s), status: String(s.status ?? ""), paymentStatus: String(s.payment_status ?? ""), subscriptionId: refId(s.subscription), customerId: refId(s.customer),
    url: typeof s.url === "string" && s.url.startsWith("https://") ? s.url : null,
  };
}

type SubscriptionObject = { id?: unknown; status?: unknown; cancel_at_period_end?: unknown; current_period_end?: unknown; items?: { data?: { id?: unknown; current_period_end?: unknown }[] } };

export async function retrieveSubscription(f: Fetch, key: string, id: string): Promise<{ id: string; status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null }> {
  const s = await call<SubscriptionObject>(f, key, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  // Newer API versions carry the period on the item, older ones on the subscription.
  const end = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return { id: idOf(s), status: String(s.status ?? ""), cancelAtPeriodEnd: s.cancel_at_period_end === true, currentPeriodEnd: typeof end === "number" && Number.isFinite(end) ? end : null };
}

/** Moves a subscription to a new monthly price from the next invoice on: the one item is repriced in place and nothing is prorated. */
export async function changeSubscriptionPrice(f: Fetch, key: string, o: { subscriptionId: string; productId: string; name: string; monthlyCents: number }, idempotencyKey: string): Promise<void> {
  if (!wholeCents(o.monthlyCents)) throw new RangeError("a subscription is for a whole, positive number of cents a month");
  const s = await call<SubscriptionObject>(f, key, "GET", `/v1/subscriptions/${encodeURIComponent(o.subscriptionId)}`);
  const itemId = s.items?.data?.[0]?.id;
  if (typeof itemId !== "string" || !itemId) throw new StripeError("Stripe's subscription had no item to change", 0);
  await call(f, key, "POST", `/v1/subscriptions/${encodeURIComponent(o.subscriptionId)}`, {
    description: o.name, proration_behavior: "none", items: [{ id: itemId, price_data: monthlyPrice(o.productId, o.monthlyCents) }],
  }, idempotencyKey);
}

/** Stops renewal at the end of the paid period; the client keeps what they paid for until then. */
export async function cancelSubscriptionAtPeriodEnd(f: Fetch, key: string, id: string, idempotencyKey: string): Promise<void> {
  await call(f, key, "POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true }, idempotencyKey);
}

export async function retrieveInvoice(f: Fetch, key: string, invoiceId: string): Promise<{ id: string; status: string; amountDue: number; amountPaid: number; currency: string; hostedUrl: string | null }> {
  const i = await call<{ id?: unknown; status?: unknown; amount_due?: unknown; amount_paid?: unknown; currency?: unknown; hosted_invoice_url?: unknown }>(f, key, "GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`);
  return {
    id: idOf(i), status: String(i.status ?? ""), amountDue: Number(i.amount_due), amountPaid: Number(i.amount_paid), currency: String(i.currency ?? ""),
    hostedUrl: typeof i.hosted_invoice_url === "string" ? i.hosted_invoice_url : null,
  };
}
