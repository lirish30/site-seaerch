import type { Fetch } from "../google/oauth";

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
  try { res = await f(`${API}${path}`, { method, headers, body }); }
  catch { throw new StripeError("could not reach Stripe", 0); } // the cause is dropped: it is not ours to relay
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

/**
 * A deposit invoice, sent by link (no automatic email or collection): create it, attach the one line, finalize it. Each call has its own idempotency key
 * (`<key>:invoice`, `:item`, `:finalize`), so repeating the whole call with the same base key after a partial failure replays what Stripe already did.
 */
export async function createDepositInvoice(
  f: Fetch, key: string,
  o: { customerId: string; amountCents: number; description: string; documentId: string; dealId: string; businessId: string },
  idempotencyKey: string,
): Promise<{ invoiceId: string; hostedUrl: string; status: string }> {
  if (!Number.isSafeInteger(o.amountCents) || o.amountCents <= 0) throw new RangeError("an invoice is for a whole, positive number of cents");
  const inv = await call<{ id?: unknown }>(f, key, "POST", "/v1/invoices", {
    customer: o.customerId, currency: "usd", collection_method: "send_invoice", days_until_due: 7, auto_advance: false,
    pending_invoice_items_behavior: "exclude", // the one line is attached by invoice id below, never swept in from the customer's pending items
    payment_settings: { payment_method_types: ["card", "us_bank_account"] },
    metadata: { document_id: o.documentId, deal_id: o.dealId, business_id: o.businessId, kind: "deposit" },
  }, `${idempotencyKey}:invoice`);
  const invoiceId = idOf(inv);
  await call(f, key, "POST", "/v1/invoiceitems", { invoice: invoiceId, customer: o.customerId, amount: o.amountCents, currency: "usd", description: o.description }, `${idempotencyKey}:item`);
  const fin = await call<{ status?: unknown; hosted_invoice_url?: unknown }>(f, key, "POST", `/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`, { auto_advance: false }, `${idempotencyKey}:finalize`);
  // The link is mailed to a client: it must be Stripe's https page.
  if (typeof fin.hosted_invoice_url !== "string" || !fin.hosted_invoice_url.startsWith("https://")) throw new StripeError("Stripe did not return a hosted invoice link", 0);
  return { invoiceId, hostedUrl: fin.hosted_invoice_url, status: typeof fin.status === "string" ? fin.status : "open" };
}

export async function retrieveInvoice(f: Fetch, key: string, invoiceId: string): Promise<{ id: string; status: string; amountDue: number; amountPaid: number; currency: string; hostedUrl: string | null }> {
  const i = await call<{ id?: unknown; status?: unknown; amount_due?: unknown; amount_paid?: unknown; currency?: unknown; hosted_invoice_url?: unknown }>(f, key, "GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`);
  return {
    id: idOf(i), status: String(i.status ?? ""), amountDue: Number(i.amount_due), amountPaid: Number(i.amount_paid), currency: String(i.currency ?? ""),
    hostedUrl: typeof i.hosted_invoice_url === "string" ? i.hosted_invoice_url : null,
  };
}
