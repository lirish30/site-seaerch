import { env } from "cloudflare:test";
import { createDraft } from "../../src/worker/db/documents";
import { insertInvoice, type InvoiceRow, type SentInvoice } from "../../src/worker/db/invoices";
import type { Fetch } from "../../src/worker/google/oauth";
import { hmacHex } from "../../src/worker/google/crypto";
import { proposal, seedDeal } from "./documents";

export const SECRET = "whsec_test_secret";
export const KEY = "sk_test_SECRETKEYVALUE123";

export interface Call { url: string; method: string; headers: Record<string, string>; body: string; form: URLSearchParams }

/** A fake Fetch that records each call and answers with respond(call, index). */
export function fakeStripe(respond: (c: Call, i: number) => Response) {
  const calls: Call[] = [];
  const f: Fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const c: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body, form: new URLSearchParams(body) };
    calls.push(c);
    return respond(c, calls.length - 1);
  };
  return { f, calls };
}

/** Signs a body the way Stripe does: t=<unix>,v1=<hmac of "t.body">. */
export async function sign(body: string, o: { secret?: string; t?: number } = {}): Promise<string> {
  const t = o.t ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${await hmacHex(o.secret ?? SECRET, `${t}.${body}`)}`;
}

/** A deal with a draft document and a deposit invoice row for it. */
export async function seedInvoice(o: { amountCents?: number; stripeInvoiceId?: string } = {}): Promise<{ invoice: SentInvoice; documentId: string; dealId: string; businessId: string }> {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const invoice = await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1",
    stripeInvoiceId: o.stripeInvoiceId ?? `in_${crypto.randomUUID().slice(0, 8)}`, amountCents: o.amountCents ?? 199850, hostedUrl: "https://invoice.stripe.com/i/x",
    ref: `deposit:${doc.id}`, description: "Deposit", test: false, lines: [{ description: "Deposit", amountCents: o.amountCents ?? 199850 }],
  });
  return { invoice, documentId: doc.id, dealId: s.dealId, businessId: s.businessId };
}

let n = 0;
/** An invoice.* event for the given invoice row. */
export function invoiceEvent(type: string, inv: InvoiceRow, over: { id?: string; object?: Record<string, unknown> } = {}) {
  return {
    id: over.id ?? `evt_${++n}_${crypto.randomUUID().slice(0, 6)}`, type,
    data: { object: { id: inv.stripeInvoiceId, object: "invoice", amount_paid: inv.amountCents, currency: "usd", metadata: { document_id: inv.documentId, kind: "deposit" }, ...over.object } },
  };
}

export const stripeJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const stripeError = (message: string, status = 400) => stripeJson({ error: { message } }, status);

/**
 * A stand-in for the part of Stripe billing uses. It makes customers, invoices, items, products and Checkout sessions as asked, answers a repeated
 * Idempotency-Key with the first answer (as Stripe does), and counts what it really made (`made` for the deposit's objects, `more` for products and Checkout sessions). `fail` answers a call instead of the default; `invoice`,
 * `session` and `subscription` answer a GET of that object (the subscription's own POST merges into it, so a later GET shows the change).
 */
export function stripeApi(o: {
  fail?: (c: Call) => Response | null | undefined; invoice?: (id: string) => Record<string, unknown>;
  session?: (id: string) => Record<string, unknown>; subscription?: (id: string) => Record<string, unknown>;
} = {}) {
  const made = { customers: 0, invoices: 0, items: 0 };
  const more = { products: 0, sessions: 0 }; // kept apart so the deposit tests' exact `made` comparison stays valid
  const replay = new Map<string, unknown>();
  const dueDays = new Map<string, number>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const tag = crypto.randomUUID().slice(0, 6); // ids are unique across the tests of a file, which share storage
  let n = 0;
  const subscriptionOf = (id: string) => subscriptions.get(id) ?? { id, status: "active", cancel_at_period_end: false, current_period_end: 1_900_000_000, items: { data: [{ id: `si_${id}` }] }, ...o.subscription?.(id) };
  const api = fakeStripe((c) => {
    const failure = o.fail?.(c);
    if (failure) return failure;
    const path = new URL(c.url).pathname;
    const id = decodeURIComponent(path.split("/").pop()!);
    if (c.method === "GET") {
      if (path.startsWith("/v1/checkout/sessions/")) return stripeJson(o.session?.(id) ?? { id, status: "complete", payment_status: "paid", subscription: `sub_${id}`, customer: "cus_1" });
      if (path.startsWith("/v1/subscriptions/")) return stripeJson(subscriptionOf(id));
      return stripeJson(o.invoice?.(id) ?? { id, status: "open", amount_due: 0, amount_paid: 0, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/x" });
    }
    const idem = c.headers["idempotency-key"];
    if (idem && replay.has(idem)) return stripeJson(replay.get(idem));
    let body: Record<string, unknown>;
    if (path === "/v1/customers") { made.customers++; body = { id: `cus_${tag}${++n}` }; }
    else if (path === "/v1/invoices") { made.invoices++; body = { id: `in_${tag}${++n}` }; dueDays.set(body.id as string, Number(c.form.get("days_until_due") ?? 0)); }
    else if (path === "/v1/invoiceitems") { made.items++; body = { id: `ii_${tag}${++n}` }; }
    else if (path === "/v1/products") { more.products++; body = { id: `prod_${tag}${++n}` }; }
    else if (path === "/v1/checkout/sessions") { more.sessions++; const sid = `cs_${tag}${++n}`; body = { id: sid, url: `https://checkout.stripe.com/c/pay/${sid}` }; }
    else if (/^\/v1\/invoices\/[^/]+\/finalize$/.test(path)) {
      const iid = path.split("/")[3];
      body = { id: iid, status: "open", hosted_invoice_url: `https://invoice.stripe.com/i/${iid}`, due_date: Math.floor(Date.now() / 1000) + (dueDays.get(iid) ?? 0) * 86400 };
    }
    else if (/^\/v1\/invoices\/[^/]+\/void$/.test(path)) body = { id: path.split("/")[3], status: "void" };
    else if (/^\/v1\/subscriptions\/[^/]+$/.test(path)) {
      body = { ...subscriptionOf(id), ...(c.form.get("cancel_at_period_end") === "true" ? { cancel_at_period_end: true } : {}) };
      subscriptions.set(id, body);
    }
    else return stripeError(`no such route ${path}`, 404);
    if (idem) replay.set(idem, body);
    return stripeJson(body);
  });
  return { ...api, made, more, creates: () => api.calls.filter((c) => c.method === "POST") };
}
