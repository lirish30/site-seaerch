import { env } from "cloudflare:test";
import { createDraft } from "../../src/worker/db/documents";
import { insertInvoice, type InvoiceRow } from "../../src/worker/db/invoices";
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
export async function seedInvoice(o: { amountCents?: number; stripeInvoiceId?: string } = {}): Promise<{ invoice: InvoiceRow; documentId: string; dealId: string; businessId: string }> {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const invoice = await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1",
    stripeInvoiceId: o.stripeInvoiceId ?? `in_${crypto.randomUUID().slice(0, 8)}`, amountCents: o.amountCents ?? 199850, hostedUrl: "https://invoice.stripe.com/i/x",
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
