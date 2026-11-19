import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, signDocument, voidDocument } from "../src/worker/db/documents";
import { getInvoiceForDocument } from "../src/worker/db/invoices";
import { ensureDepositInvoice, setStripeFetchForTests } from "../src/worker/documents/deposit";
import { afterSign, signProposal } from "../src/worker/documents/public";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { setMailDeps } from "../src/worker/mail/deps";
import { KEY, stripeApi, stripeError, stripeJson } from "./fixtures/stripe";
import { clientSig, proposal, readyToSend, seedDeal, sendDraft, stubPdfRenderer } from "./fixtures/documents";

const FAR = "2099-01-01T00:00:00.000Z";
const SIGNED_AT = "2026-12-02T09:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type E = typeof env;
const E_TEST = { ...env, STRIPE_SECRET_KEY: KEY } as E;
const LIVE = "sk_live_LIVEKEYVALUE456";
const HOSTED = (invoiceId: string) => `https://invoice.stripe.com/i/${invoiceId}`;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); stubPdfRenderer(); });
afterEach(() => { errors.mockRestore(); setStripeFetchForTests(null); setPdfRendererForTests(null); setMailDeps(null); });

/** A sent proposal for a real deal; `signed` signs it the way the page does, without the follow-up steps. */
async function seed(o: { test?: boolean; signed?: boolean; content?: Partial<ProposalContent> } = {}) {
  const s = await seedDeal();
  const content: ProposalContent = { ...proposal(), ...o.content };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  if (o.signed !== false) expect(await signDocument(env.DB, doc.id, clientSig(hash), SIGNED_AT)).toBe("signed");
  return { ...s, doc, hash, token: doc.token! };
}
const notes = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === "note").map((a) => a.detail ?? "");
const failureNotes = async (businessId: string) => (await notes(businessId)).filter((n) => n.startsWith("deposit invoice not created:"));

/** The Worker as a prospect's browser (no cookie) reaches it. */
const call = (path: string, init: RequestInit = {}, e: Partial<E> = { STRIPE_SECRET_KEY: KEY }) => worker.fetch(new Request(`https://x/api/public${path}`, init), { ...env, ...e } as E, ctx);
const pay = (token: string, e?: Partial<E>) => call(`/p/${token}/pay`, { method: "POST" }, e);
const ageInvoice = (documentId: string) => env.DB.prepare(`UPDATE invoices SET created_at = '2026-01-01T00:00:00.000Z' WHERE document_id = ?`).bind(documentId).run();

describe("the deposit invoice at signing", () => {
  it("signing creates exactly one deposit invoice for the schedule's depositCents", async () => {
    const mail = await readyToSend();
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed({ signed: false });
    const r = await signProposal(E_TEST, s.token, { name: "Pat Jones", consent: true, authority: true, sha256: s.hash }, { now: new Date(SIGNED_AT), ip: null, userAgent: null });
    expect(r.ok).toBe(true);
    expect(mail.sent).toHaveLength(2); // the signed copy and the notice: the invoice is a step after them, not instead of them

    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
    const [customer, invoice, item, finalize] = api.creates();
    expect(customer.form.get("metadata[business_id]")).toBe(s.businessId);
    expect(invoice.form.get("metadata[document_id]")).toBe(s.doc.id);
    expect(invoice.form.get("metadata[deal_id]")).toBe(s.dealId);
    expect(item.form.get("amount")).toBe("199850");
    expect(item.form.get("currency")).toBe("usd");
    expect(item.form.get("description")).toBe("Ace Plumbing — deposit (SL-ABCDEF v1)");
    expect(finalize.url).toMatch(/\/finalize$/);
    // Fixed keys per document and business: a repeat of the whole call replays what Stripe already did.
    expect([customer, invoice, item, finalize].map((c) => c.headers["idempotency-key"])).toEqual([
      `customer:${s.businessId}`, `deposit:${s.doc.id}:invoice`, `deposit:${s.doc.id}:item`, `deposit:${s.doc.id}:finalize`]);

    const row = (await getInvoiceForDocument(env.DB, s.doc.id))!;
    expect(row).toMatchObject({ businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, kind: "deposit", amountCents: 199850, status: "open", stripeCustomerId: expect.stringMatching(/^cus_/) });
    expect(r.ok && r.page).toMatchObject({ state: "signed", payment: { state: "open", amountCents: 199850, url: row.hostedUrl } });
    expect(row.hostedUrl).toBe(HOSTED(row.stripeInvoiceId));
  });

  it("a retried afterSign does not create a second invoice or a second customer", async () => {
    await readyToSend();
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    await afterSign(E_TEST, (await getDocument(env.DB, s.doc.id))!);
    await afterSign(E_TEST, (await getDocument(env.DB, s.doc.id))!);
    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?`).bind(s.doc.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM stripe_customers WHERE business_id = ?`).bind(s.businessId).first<{ n: number }>())!.n).toBe(1);
  });

  it("a retry after a half-finished attempt recovers on the same keys instead of making a second invoice", async () => {
    const api = stripeApi({ fail: (c) => (c.url.endsWith("/invoiceitems") && !failed++ ? stripeError("Stripe had a hiccup", 500) : null) });
    let failed = 0;
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await ensureDepositInvoice(E_TEST, s.doc.id)).toEqual({ state: "unavailable" });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull(); // no half row, though a draft invoice is left at Stripe
    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 0 });
    expect(await failureNotes(s.businessId)).toEqual(["deposit invoice not created: Stripe had a hiccup"]);

    expect(await ensureDepositInvoice(E_TEST, s.doc.id)).toMatchObject({ state: "open", amountCents: 199850 });
    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 }); // the draft was replayed by its key, not made again
    const keys = api.creates().map((c) => c.headers["idempotency-key"]);
    expect(keys.filter((k) => k === `deposit:${s.doc.id}:invoice`)).toHaveLength(2);
    expect(keys.filter((k) => k === `customer:${s.businessId}`)).toHaveLength(1); // the saved customer is reused
  });

  it("two requests at once leave one invoice row, and both see it", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    const [a, b] = await Promise.all([ensureDepositInvoice(E_TEST, s.doc.id), ensureDepositInvoice(E_TEST, s.doc.id)]);
    expect(a).toMatchObject({ state: "open" });
    expect(b).toEqual(a);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?`).bind(s.doc.id).first<{ n: number }>())!.n).toBe(1);
    expect(api.made.invoices).toBe(1);
  });

  it("an unavailable Stripe leaves the signature and reports unavailable", async () => {
    await readyToSend();
    const down = vi.fn(async () => { throw new Error("connect ECONNRESET api.stripe.com"); });
    setStripeFetchForTests(down);
    const s = await seed({ signed: false });
    const r = await signProposal(E_TEST, s.token, { name: "Pat Jones", consent: true, authority: true, sha256: s.hash }, { now: new Date(SIGNED_AT), ip: null, userAgent: null });
    expect(r.ok && r.page).toMatchObject({ state: "signed", signed: { name: "Pat Jones" }, payment: { state: "unavailable" } });
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ status: "signed", paidAt: null });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
    expect(await failureNotes(s.businessId)).toEqual(["deposit invoice not created: could not reach Stripe"]);
    // And the page can ask again once Stripe is back.
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    expect(await (await pay(s.token)).json()).toMatchObject({ state: "open", amountCents: 199850 });
  });

  it("an invoice that cannot be saved or a link that is not https is unavailable and leaves no row", async () => {
    const api = stripeApi({ fail: (c) => (/finalize$/.test(c.url) ? stripeJson({ id: "in_x", status: "open", hosted_invoice_url: "http://insecure.example/i" }) : null) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await ensureDepositInvoice(E_TEST, s.doc.id)).toEqual({ state: "unavailable" });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
    expect(await failureNotes(s.businessId)).toEqual(["deposit invoice not created: Stripe did not return a hosted invoice link"]);
  });

  it("Stripe refusing a retry because the request changed under the same key is unavailable with a note", async () => {
    const api = stripeApi({ fail: (c) => (/\/v1\/invoices$/.test(c.url) ? stripeError("Keys for idempotent requests can only be used with the same parameters they were first used with.", 400) : null) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await ensureDepositInvoice(E_TEST, s.doc.id)).toEqual({ state: "unavailable" });
    expect((await failureNotes(s.businessId))[0]).toMatch(/idempotent requests/);
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
  });

  it("the failure note holds no key, is one line and is capped", async () => {
    const api = stripeApi({ fail: () => stripeError(`bad key ${KEY} here\nsecond line ${"x".repeat(600)} ${KEY}`, 401) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    const out = await ensureDepositInvoice(E_TEST, s.doc.id);
    expect(out).toEqual({ state: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("sk_test");
    const [note] = await failureNotes(s.businessId);
    expect(note.startsWith("deposit invoice not created: bad key [key] here second line x")).toBe(true);
    expect(note).not.toContain(KEY);
    expect(note).not.toContain("SECRETKEYVALUE");
    expect(note).not.toMatch(/\n/);
    expect(note.length).toBeLessThanOrEqual("deposit invoice not created: ".length + 200);
    for (const c of errors.mock.calls) expect(JSON.stringify(c)).not.toContain("SECRETKEYVALUE");
  });

  it("the same failure is noted once, not every time the client presses try again", async () => {
    setStripeFetchForTests(stripeApi({ fail: () => stripeError("Stripe is having a bad day", 503) }).f);
    const s = await seed();
    for (let i = 0; i < 4; i++) await ensureDepositInvoice(E_TEST, s.doc.id);
    expect(await failureNotes(s.businessId)).toEqual(["deposit invoice not created: Stripe is having a bad day"]);
  });

  it("with no Stripe key it is unavailable, calls nothing and says nothing on the timeline", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await ensureDepositInvoice({ ...env, STRIPE_SECRET_KEY: undefined } as E, s.doc.id)).toEqual({ state: "unavailable" });
    expect(await ensureDepositInvoice({ ...env, STRIPE_SECRET_KEY: "pk_test_publishable" } as E, s.doc.id)).toEqual({ state: "unavailable" });
    expect(api.calls).toHaveLength(0);
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
  });

  it("a test document with a live key is unavailable and never reaches Stripe", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed({ test: true });
    expect(await ensureDepositInvoice({ ...env, STRIPE_SECRET_KEY: LIVE } as E, s.doc.id)).toEqual({ state: "unavailable" });
    expect(api.calls).toHaveLength(0);
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
    const [note] = await failureNotes(s.businessId);
    expect(note).toBe("deposit invoice not created: a test copy never makes a live charge");
    expect(note).not.toContain("LIVEKEYVALUE");
  });

  it("a test document with a test key, and a real one with either, are allowed", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const t = await seed({ test: true });
    expect(await ensureDepositInvoice(E_TEST, t.doc.id)).toMatchObject({ state: "open" });
    const live = await seed();
    expect(await ensureDepositInvoice({ ...env, STRIPE_SECRET_KEY: LIVE } as E, live.doc.id)).toMatchObject({ state: "open" });
    expect(api.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.calls.at(-1)!.headers.authorization).toBe(`Bearer ${LIVE}`);
  });

  it("only a signed document has an invoice", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const open = await seed({ signed: false });
    expect(await ensureDepositInvoice(E_TEST, open.doc.id)).toEqual({ state: "none" });
    const voided = await seed({ signed: false });
    await voidDocument(env.DB, voided.doc.id, "x");
    expect(await ensureDepositInvoice(E_TEST, voided.doc.id)).toEqual({ state: "none" });
    expect(await ensureDepositInvoice(E_TEST, "no-such-document")).toEqual({ state: "none" });
    expect(api.calls).toHaveLength(0);
  });

  it("the deposit amount is the schedule's, including a prepaid first month, never recomputed", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const schedule: ProposalContent["schedule"] = {
      milestones: [{ id: "m1", label: "Deposit at signing", dueOn: "signing", amountCents: 150000 }, { id: "m2", label: "Site finished", dueOn: "site_finished", amountCents: 150000 }],
      recurring: [{ key: "care", name: "Care", monthlyCents: 4999, startsOn: "signing", termMonths: null, firstMonthPrepaid: true }],
      depositCents: 154999, // the signing milestone plus the first month of Care
    };
    const s = await seed({ content: { schedule } });
    expect(await ensureDepositInvoice(E_TEST, s.doc.id)).toEqual({ state: "open", amountCents: 154999, url: expect.stringMatching(/^https:\/\//) });
    expect(api.creates().find((c) => c.url.endsWith("/invoiceitems"))!.form.get("amount")).toBe("154999");
    expect((await getInvoiceForDocument(env.DB, s.doc.id))!.amountCents).toBe(154999);
  });
});

describe("POST /api/public/p/:token/pay", () => {
  it("a second pay request reuses the open invoice", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    const a = await pay(s.token);
    const b = await pay(s.token);
    expect(a.status).toBe(200);
    const first = await a.json<any>();
    expect(first).toMatchObject({ state: "open", amountCents: 199850 });
    expect(await b.json()).toEqual(first);
    expect(api.calls).toHaveLength(4); // customer, invoice, item, finalize: nothing the second time (the invoice is too new to ask Stripe about)
    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
  });

  it("the page carries the payment state: unavailable before an invoice, open with its link after", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect((await (await call(`/p/${s.token}`)).json<any>()).payment).toEqual({ state: "unavailable" });
    expect(api.calls).toHaveLength(0); // a page load never creates an invoice
    await pay(s.token);
    expect((await (await call(`/p/${s.token}`)).json<any>()).payment).toMatchObject({ state: "open", amountCents: 199850 });
    const unsigned = await seed({ signed: false });
    expect((await (await call(`/p/${unsigned.token}`)).json<any>()).payment).toEqual({ state: "none" });
  });

  it("an open invoice that Stripe reports paid is marked paid on the next request", async () => {
    let status = "open";
    const api = stripeApi({ invoice: (id) => ({ id, status, amount_due: 0, amount_paid: status === "paid" ? 199850 : 0, currency: "usd", hosted_invoice_url: HOSTED(id) }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await pay(s.token);
    await ageInvoice(s.doc.id);
    expect(await (await pay(s.token)).json()).toMatchObject({ state: "open" }); // asked Stripe; still unpaid
    expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(1);

    status = "paid"; // the webhook never came
    expect(await (await pay(s.token)).json()).toEqual({ state: "paid", amountCents: 199850 });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toMatchObject({ status: "paid", mismatch: null });
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).not.toBeNull();
    expect((await (await call(`/p/${s.token}`)).json<any>()).payment).toEqual({ state: "paid", amountCents: 199850 });
    // Paid is final: nothing more is asked of Stripe.
    const gets = api.calls.filter((c) => c.method === "GET").length;
    await pay(s.token);
    expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(gets);
  });

  it("a page load re-checks an old open invoice too, and a new one is left to the webhook", async () => {
    const api = stripeApi({ invoice: (id) => ({ id, status: "paid", amount_due: 0, amount_paid: 199850, currency: "usd", hosted_invoice_url: HOSTED(id) }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await pay(s.token);
    expect((await (await call(`/p/${s.token}`)).json<any>()).payment).toMatchObject({ state: "open" });
    expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(0);
    await ageInvoice(s.doc.id);
    expect((await (await call(`/p/${s.token}`)).json<any>()).payment).toEqual({ state: "paid", amountCents: 199850 });
  });

  it("a paid answer for another amount is a mismatch: the invoice stays open and nothing is marked paid", async () => {
    const api = stripeApi({ invoice: (id) => ({ id, status: "paid", amount_due: 0, amount_paid: 100, currency: "usd", hosted_invoice_url: HOSTED(id) }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await pay(s.token);
    await ageInvoice(s.doc.id);
    expect(await (await pay(s.token)).json()).toMatchObject({ state: "open" });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toMatchObject({ status: "open", paidAt: null, mismatch: expect.stringMatching(/amount paid 100/) });
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeNull();
  });

  it("a void invoice is unavailable, and Stripe being down changes nothing", async () => {
    let mode: "void" | "down" = "down";
    const api = stripeApi({ fail: (c) => (c.method === "GET" && mode === "down" ? stripeError("Stripe is down", 500) : null), invoice: (id) => ({ id, status: "void", amount_due: 0, amount_paid: 0, currency: "usd" }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await pay(s.token);
    await ageInvoice(s.doc.id);
    expect(await (await pay(s.token)).json()).toMatchObject({ state: "open" });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toMatchObject({ status: "open" });
    mode = "void";
    expect(await (await pay(s.token)).json()).toEqual({ state: "unavailable" });
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toMatchObject({ status: "void" });
  });

  it("is a 404 for anything that is not a signed document, with the same headers as the other public routes", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const open = await seed({ signed: false });
    const voided = await seed({ signed: false });
    await voidDocument(env.DB, voided.doc.id, "x");
    for (const token of [open.token, voided.token, "A".repeat(43), "short", "A".repeat(44)]) {
      const r = await pay(token);
      expect(r.status, token).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(api.calls).toHaveLength(0);
    const ok = await pay((await seed()).token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("needs no cookie, but only POST on exactly this path: every neighbour stays protected", async () => {
    const s = await seed();
    setStripeFetchForTests(stripeApi().f);
    expect((await pay(s.token)).status).toBe(200);
    for (const [path, method] of [
      [`/p/${s.token}/pay`, "GET"], [`/p/${s.token}/pay`, "PUT"], [`/p/${s.token}/pay`, "DELETE"], [`/p/${s.token}/pay`, "PATCH"], [`/p/${s.token}/pay/`, "POST"], [`/p/${s.token}/pay/x`, "POST"],
      [`/p/${s.token}/pay.json`, "POST"], [`/p/${s.token}/PAY`, "POST"], ["/p//pay", "POST"], [`/p/${s.token}/x/pay`, "POST"], [`/p/${s.token}/payx`, "POST"], ["/pay", "POST"], ["/p/pay", "POST"],
      [`/p/${s.token}/deposit`, "POST"],
    ] as const) {
      const r = await call(path, { method, body: method === "GET" ? undefined : "{}" });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it("the limiter applies to it, keyed by the link and the address, before anything runs", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    const keys: string[] = [];
    const CLIENT_LIMITER = { limit: async (o: { key: string }) => { keys.push(o.key); return { success: false }; } } as unknown as RateLimit;
    const r = await call(`/p/${s.token}/pay`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } }, { STRIPE_SECRET_KEY: KEY, CLIENT_LIMITER });
    expect(r.status).toBe(429);
    expect(keys).toEqual([`${s.token}:203.0.113.9`]);
    expect(api.calls).toHaveLength(0);
    expect(await getInvoiceForDocument(env.DB, s.doc.id)).toBeNull();
  });
});

describe("the owner's retry, POST /api/documents/:id/deposit", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const owner = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api${path}`, init), E_TEST, ctx);

  it("requires sign-in", async () => {
    const s = await seed();
    expect((await owner(`/documents/${s.doc.id}/deposit`, { method: "POST" })).status).toBe(401);
  });

  it("makes (or returns) the invoice for a signed document, 409 for one that is not signed, 404 for an unknown one", async () => {
    const api = stripeApi();
    setStripeFetchForTests(api.f);
    const s = await seed();
    const post = (id: string) => owner(`/documents/${id}/deposit`, { method: "POST", headers: { cookie } });
    expect(await (await post(s.doc.id)).json()).toMatchObject({ state: "open", amountCents: 199850 });
    expect(await (await post(s.doc.id)).json()).toMatchObject({ state: "open" });
    expect(api.made.invoices).toBe(1);
    const unsigned = await seed({ signed: false });
    expect((await post(unsigned.doc.id)).status).toBe(409);
    expect((await post("no-such-document")).status).toBe(404);
  });

  it("the deal's proposal read carries the current document's invoice, or null before it has one", async () => {
    setStripeFetchForTests(stripeApi().f);
    const s = await seed();
    const read = async () => (await SELF.fetch(`https://x/api/deals/${s.dealId}/proposal`, { headers: { cookie } })).json<any>();
    expect(await read()).toMatchObject({ current: { id: s.doc.id }, invoice: null });
    await ensureDepositInvoice(E_TEST, s.doc.id);
    expect(await read()).toMatchObject({ current: { id: s.doc.id }, invoice: { documentId: s.doc.id, status: "open", amountCents: 199850 } });
  });
});
