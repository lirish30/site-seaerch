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
 * A stand-in for the part of Stripe the deposit uses. It makes a customer, an invoice and an item as asked, answers a repeated Idempotency-Key with the
 * first answer (as Stripe does), and counts what it really made. `fail` answers a call instead of the default; `invoice` answers a GET of an invoice.
 */
export function stripeApi(o: { fail?: (c: Call) => Response | null | undefined; invoice?: (id: string) => Record<string, unknown> } = {}) {
  const made = { customers: 0, invoices: 0, items: 0 };
  const replay = new Map<string, unknown>();
  const tag = crypto.randomUUID().slice(0, 6); // ids are unique across the tests of a file, which share storage
  let n = 0;
  const api = fakeStripe((c) => {
    const failure = o.fail?.(c);
    if (failure) return failure;
    const path = new URL(c.url).pathname;
    if (c.method === "GET") {
      const id = decodeURIComponent(path.split("/").pop()!);
      return stripeJson(o.invoice?.(id) ?? { id, status: "open", amount_due: 0, amount_paid: 0, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/x" });
    }
    const idem = c.headers["idempotency-key"];
    if (idem && replay.has(idem)) return stripeJson(replay.get(idem));
    let body: Record<string, unknown>;
    if (path === "/v1/customers") { made.customers++; body = { id: `cus_${tag}${++n}` }; }
    else if (path === "/v1/invoices") { made.invoices++; body = { id: `in_${tag}${++n}` }; }
    else if (path === "/v1/invoiceitems") { made.items++; body = { id: `ii_${tag}${++n}` }; }
    else if (/^\/v1\/invoices\/[^/]+\/finalize$/.test(path)) body = { id: path.split("/")[3], status: "open", hosted_invoice_url: `https://invoice.stripe.com/i/${path.split("/")[3]}` };
    else return stripeError(`no such route ${path}`, 404);
    if (idem) replay.set(idem, body);
    return stripeJson(body);
  });
  return { ...api, made, creates: () => api.calls.filter((c) => c.method === "POST") };
}
