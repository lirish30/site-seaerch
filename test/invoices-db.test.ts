import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EPOCH, EVENT_LEASE_MS, attachStripeInvoice, claimEvent, discardDraftInvoice, finishEvent, getInvoice, getInvoiceByRef, getInvoiceByStripeId, getInvoiceForDocument,
  getStripeCustomer, insertDraftInvoice, insertInvoice, listInvoices, markInvoice, paidTotalForDocument, recordEvent, releaseEvent, saveStripeCustomer,
} from "../src/worker/db/invoices";
import { seedInvoice } from "./fixtures/stripe";
import { seedDoc, seedDraft } from "./fixtures/billing";
import { createDraft } from "../src/worker/db/documents";
import { proposal, seedDeal } from "./fixtures/documents";

describe("invoices db", () => {
  it("one deposit invoice per document", async () => {
    const s = await seedInvoice();
    await expect(insertInvoice(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: "in_second", amountCents: 100, hostedUrl: "https://x",
    })).rejects.toThrow();
    expect((await getInvoiceForDocument(env.DB, s.documentId))!.stripeInvoiceId).toBe(s.invoice.stripeInvoiceId);
  });

  it("a Stripe invoice id belongs to one row", async () => {
    const a = await seedInvoice({ stripeInvoiceId: "in_same" });
    const b = await seedDeal();
    await expect(insertInvoice(env.DB, {
      businessId: b.businessId, dealId: b.dealId, documentId: a.documentId, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: "in_same", amountCents: 100, hostedUrl: "https://x",
    })).rejects.toThrow();
  });

  it("reads back a new row as open, with no payment and no mismatch", async () => {
    const { invoice } = await seedInvoice({ amountCents: 5000 });
    expect(invoice).toMatchObject({ kind: "deposit", status: "open", amountCents: 5000, mismatch: null, paidAt: null, stripeCustomerId: "cus_1" });
    expect(invoice.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId)).toEqual(invoice);
    expect(await getInvoiceByStripeId(env.DB, "in_missing")).toBeNull();
    expect(await getInvoiceForDocument(env.DB, "nope")).toBeNull();
  });

  it("money is whole positive cents", async () => {
    const s = await seedDeal();
    const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    const base = { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit" as const, stripeCustomerId: "c", stripeInvoiceId: "in_z", hostedUrl: "https://x" };
    await expect(insertInvoice(env.DB, { ...base, amountCents: 0 })).rejects.toThrow();
    await expect(insertInvoice(env.DB, { ...base, amountCents: 10.5 })).rejects.toThrow();
  });

  it("markInvoice patches a row, and a guard stops it moving off a state", async () => {
    const { invoice } = await seedInvoice();
    expect(await markInvoice(env.DB, invoice.id, { status: "paid", paidAt: "2026-12-02T00:00:00.000Z" })).toBe(true);
    expect(await markInvoice(env.DB, invoice.id, { status: "failed" }, { notFrom: ["paid"] })).toBe(false);
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))).toMatchObject({ status: "paid", paidAt: "2026-12-02T00:00:00.000Z" });
    expect(await markInvoice(env.DB, "missing", { status: "void" })).toBe(false);
  });

  it("recordEvent is false on a repeat", async () => {
    expect(await recordEvent(env.DB, "evt_dup", "invoice.paid")).toBe(true);
    expect(await recordEvent(env.DB, "evt_dup", "invoice.paid")).toBe(false);
  });

  describe("event claims", () => {
    const T0 = new Date("2026-12-01T10:00:00.000Z");
    const at = (ms: number) => new Date(T0.getTime() + ms);
    const row = (id: string) => env.DB.prepare(`SELECT received_at, processed_at FROM stripe_events WHERE id = ?`).bind(id).first<{ received_at: string; processed_at: string | null }>();

    it("the first delivery claims, a delivery while the claim is fresh is busy", async () => {
      expect(await claimEvent(env.DB, "evt_c1", "invoice.paid", T0)).toBe("claimed");
      expect(await row("evt_c1")).toEqual({ received_at: T0.toISOString(), processed_at: null });
      expect(await claimEvent(env.DB, "evt_c1", "invoice.paid", at(1000))).toBe("busy");
      expect(await claimEvent(env.DB, "evt_c1", "invoice.paid", at(EVENT_LEASE_MS - 1))).toBe("busy");
    });

    it("a finished event is a duplicate, however much later", async () => {
      await claimEvent(env.DB, "evt_c2", "invoice.paid", T0);
      await finishEvent(env.DB, "evt_c2", at(5));
      expect((await row("evt_c2"))!.processed_at).toBe(at(5).toISOString());
      expect(await claimEvent(env.DB, "evt_c2", "invoice.paid", at(1000))).toBe("duplicate");
      expect(await claimEvent(env.DB, "evt_c2", "invoice.paid", at(30 * EVENT_LEASE_MS))).toBe("duplicate");
    });

    it("an unfinished claim past the lease is taken over, and the new claim is fresh", async () => {
      await claimEvent(env.DB, "evt_c3", "invoice.paid", T0);
      expect(await claimEvent(env.DB, "evt_c3", "invoice.paid", at(EVENT_LEASE_MS + 1))).toBe("claimed");
      expect((await row("evt_c3"))!.received_at).toBe(at(EVENT_LEASE_MS + 1).toISOString());
      expect(await claimEvent(env.DB, "evt_c3", "invoice.paid", at(EVENT_LEASE_MS + 2))).toBe("busy");
    });

    it("a released claim is taken over at once", async () => {
      await claimEvent(env.DB, "evt_c4", "invoice.paid", T0);
      await releaseEvent(env.DB, "evt_c4");
      expect((await row("evt_c4"))!.received_at).toBe(EPOCH);
      expect(await claimEvent(env.DB, "evt_c4", "invoice.paid", at(1))).toBe("claimed");
    });

    it("releasing never reopens a finished event", async () => {
      await claimEvent(env.DB, "evt_c5", "invoice.paid", T0);
      await finishEvent(env.DB, "evt_c5", at(1));
      await releaseEvent(env.DB, "evt_c5");
      expect((await row("evt_c5"))!.received_at).toBe(T0.toISOString());
      expect(await claimEvent(env.DB, "evt_c5", "invoice.paid", at(10 * EVENT_LEASE_MS))).toBe("duplicate");
    });

    it("of several deliveries racing for an expired claim, one wins", async () => {
      await claimEvent(env.DB, "evt_c6", "invoice.paid", T0);
      const out = await Promise.all([1, 2, 3, 4].map(() => claimEvent(env.DB, "evt_c6", "invoice.paid", at(EVENT_LEASE_MS * 2))));
      expect(out.filter((o) => o === "claimed")).toHaveLength(1);
      expect(out.filter((o) => o === "busy")).toHaveLength(3);
    });
  });

  it("a business keeps the first Stripe customer saved for it", async () => {
    const s = await seedDeal();
    expect(await getStripeCustomer(env.DB, s.businessId)).toBeNull();
    expect(await saveStripeCustomer(env.DB, s.businessId, "cus_first")).toBe("cus_first");
    expect(await saveStripeCustomer(env.DB, s.businessId, "cus_second")).toBe("cus_first");
    expect(await getStripeCustomer(env.DB, s.businessId)).toBe("cus_first");
  });

  describe("draft invoices", () => {
    const base = (s: Awaited<ReturnType<typeof seedDoc>>, over: Partial<Parameters<typeof insertDraftInvoice>[1]> = {}) => ({
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, changeOrderId: null, subscriptionId: null,
      kind: "milestone" as const, ref: `milestone:${crypto.randomUUID()}`, test: false, description: "Milestone", lines: [{ description: "Design approved", amountCents: 100000 }], ...over,
    });

    it("insertDraftInvoice twice with one ref returns the first and created false", async () => {
      const s = await seedDoc();
      const o = base(s, { ref: "milestone:one", lines: [{ description: "A", amountCents: 70000 }, { description: "B", amountCents: 30050 }] });
      const a = await insertDraftInvoice(env.DB, o);
      expect(a.created).toBe(true);
      expect(a.invoice).toMatchObject({
        status: "draft", kind: "milestone", ref: "milestone:one", amountCents: 100050, stripeCustomerId: null, stripeInvoiceId: null, hostedUrl: null, dueOn: null, sentAt: null,
        failedOn: null, paidAt: null, mismatch: null, test: false, description: "Milestone", projectId: null, changeOrderId: null, subscriptionId: null,
        lines: [{ description: "A", amountCents: 70000 }, { description: "B", amountCents: 30050 }],
      });
      const b = await insertDraftInvoice(env.DB, { ...o, lines: [{ description: "Other", amountCents: 1 }] });
      expect(b.created).toBe(false);
      expect(b.invoice).toEqual(a.invoice);
      expect(await getInvoiceByRef(env.DB, "milestone:one")).toEqual(a.invoice);
      expect(await getInvoice(env.DB, a.invoice.id)).toEqual(a.invoice);
      expect(await getInvoice(env.DB, "nope")).toBeNull();
      expect(await getInvoiceByRef(env.DB, "nope")).toBeNull();
    });

    it("an invoice is for whole, positive cents", async () => {
      const s = await seedDoc();
      await expect(insertDraftInvoice(env.DB, base(s, { lines: [] }))).rejects.toThrow();
      await expect(insertDraftInvoice(env.DB, base(s, { lines: [{ description: "x", amountCents: 0 }] }))).rejects.toThrow();
      await expect(insertDraftInvoice(env.DB, base(s, { lines: [{ description: "x", amountCents: 10.5 }] }))).rejects.toThrow();
    });

    it("a draft cannot carry a stripe id (CHECK)", async () => {
      const { invoice } = await seedDraft();
      await expect(env.DB.prepare(`UPDATE invoices SET stripe_invoice_id = 'in_sneaky' WHERE id = ?`).bind(invoice.id).run()).rejects.toThrow();
      // The same row may carry one once it is open.
      await env.DB.prepare(`UPDATE invoices SET stripe_invoice_id = 'in_fine_1', status = 'open' WHERE id = ?`).bind(invoice.id).run();
    });

    it("attachStripeInvoice moves draft to open once", async () => {
      const { invoice } = await seedDraft();
      const o = { stripeCustomerId: "cus_9", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: "https://invoice.stripe.com/i/9", dueOn: "2026-12-20", now: "2026-12-13T10:00:00.000Z" };
      expect(await attachStripeInvoice(env.DB, invoice.id, o)).toBe(true);
      expect(await getInvoice(env.DB, invoice.id)).toMatchObject({
        status: "open", stripeCustomerId: "cus_9", stripeInvoiceId: o.stripeInvoiceId, hostedUrl: o.hostedUrl, dueOn: "2026-12-20", sentAt: o.now,
      });
      expect(await attachStripeInvoice(env.DB, invoice.id, { ...o, stripeInvoiceId: "in_other" })).toBe(false);
      expect((await getInvoice(env.DB, invoice.id))!.stripeInvoiceId).toBe(o.stripeInvoiceId);
      expect(await getInvoiceByStripeId(env.DB, o.stripeInvoiceId)).toMatchObject({ id: invoice.id });
      expect(await attachStripeInvoice(env.DB, "missing", o)).toBe(false);
    });

    it("discardDraftInvoice only discards a draft", async () => {
      const a = await seedDraft();
      expect(await discardDraftInvoice(env.DB, a.invoice.id)).toBe(true);
      expect((await getInvoice(env.DB, a.invoice.id))!.status).toBe("void");
      expect(await discardDraftInvoice(env.DB, a.invoice.id)).toBe(false);
      const b = await seedDraft();
      await attachStripeInvoice(env.DB, b.invoice.id, { stripeCustomerId: "c", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: "https://x", dueOn: null, now: "2026-12-13T10:00:00.000Z" });
      expect(await discardDraftInvoice(env.DB, b.invoice.id)).toBe(false);
      expect((await getInvoice(env.DB, b.invoice.id))!.status).toBe("open");
    });

    it("paidTotalForDocument counts only the kinds asked for", async () => {
      const s = await seedDoc();
      const m = await seedDraft({ seed: s, kind: "milestone", lines: [{ description: "m", amountCents: 50000 }] });
      const h = await seedDraft({ seed: s, kind: "hourly", lines: [{ description: "h", amountCents: 9500 }] });
      const m2 = await seedDraft({ seed: s, kind: "milestone", lines: [{ description: "m2", amountCents: 20000 }] });
      for (const x of [m, h]) await env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = '2026-12-14T00:00:00.000Z' WHERE id = ?`).bind(x.invoice.id).run();
      expect(m2.invoice.status).toBe("draft");
      expect(await paidTotalForDocument(env.DB, s.documentId, ["milestone"])).toBe(50000);
      expect(await paidTotalForDocument(env.DB, s.documentId, ["hourly"])).toBe(9500);
      expect(await paidTotalForDocument(env.DB, s.documentId, ["milestone", "hourly"])).toBe(59500);
      expect(await paidTotalForDocument(env.DB, s.documentId, ["deposit"])).toBe(0);
      expect(await paidTotalForDocument(env.DB, s.documentId, [])).toBe(0);
    });

    it("a second deposit for a document is refused but a second milestone is not", async () => {
      const s = await seedDoc();
      await seedDraft({ seed: s, kind: "deposit", ref: "deposit:first" });
      await expect(seedDraft({ seed: s, kind: "deposit", ref: "deposit:second" })).rejects.toThrow();
      const m1 = await seedDraft({ seed: s, kind: "milestone" });
      const m2 = await seedDraft({ seed: s, kind: "milestone" });
      expect([m1.created, m2.created]).toEqual([true, true]);
    });

    it("listInvoices filters and lists newest first", async () => {
      const s = await seedDoc();
      const a = await seedDraft({ seed: s, kind: "milestone" });
      await new Promise((r) => setTimeout(r, 3));
      const b = await seedDraft({ seed: s, kind: "hourly" });
      await markInvoice(env.DB, b.invoice.id, { status: "void" });
      expect((await listInvoices(env.DB, { businessId: s.businessId })).map((i) => i.id)).toEqual([b.invoice.id, a.invoice.id]);
      expect((await listInvoices(env.DB, { businessId: s.businessId, kinds: ["milestone"] })).map((i) => i.id)).toEqual([a.invoice.id]);
      expect((await listInvoices(env.DB, { businessId: s.businessId, statuses: ["void"] })).map((i) => i.id)).toEqual([b.invoice.id]);
      expect(await listInvoices(env.DB, { businessId: s.businessId, statuses: [] })).toEqual([]);
      expect(await listInvoices(env.DB, { businessId: "nobody" })).toEqual([]);
      expect((await listInvoices(env.DB)).length).toBeGreaterThanOrEqual(2);
    });

    it("markInvoice also sets the due and failed dates", async () => {
      const { invoice } = await seedDraft();
      expect(await markInvoice(env.DB, invoice.id, { dueOn: "2026-12-31", failedOn: "2027-01-02" })).toBe(true);
      expect(await getInvoice(env.DB, invoice.id)).toMatchObject({ dueOn: "2026-12-31", failedOn: "2027-01-02" });
      expect(await markInvoice(env.DB, invoice.id, { failedOn: null })).toBe(true);
      expect((await getInvoice(env.DB, invoice.id))!.failedOn).toBeNull();
    });
  });

  // Last in the file: it rebuilds the invoices table from its 0053 shape and runs migration 0057 again over it, so what follows would see a different table.
  it("the migration keeps an existing deposit and gives it ref deposit:<document>", async () => {
    const s = await seedDoc();
    await env.DB.prepare(`UPDATE documents SET test = 1 WHERE id = ?`).bind(s.documentId).run();
    const m0053 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0053"))!;
    const m0057 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0057"))!;
    const oldInvoiceSql = m0053.queries.filter((q) => /CREATE (UNIQUE )?(TABLE|INDEX) (uq_invoices|idx_invoices|invoices)/.test(q));
    expect(oldInvoiceSql).toHaveLength(3);
    // Take the 0057 objects away (the invoices table last: nothing may point at it first), put the 0053 table back, and add a deposit the old way.
    for (const t of ["invoice_nudges", "billing_holds", "invoices", "subscriptions", "stripe_products"]) await env.DB.prepare(`DROP TABLE ${t}`).run();
    await env.DB.prepare(`ALTER TABLE settings DROP COLUMN billing_config`).run();
    for (const q of oldInvoiceSql) await env.DB.prepare(q).run();
    await env.DB.prepare(
      `INSERT INTO invoices (id, business_id, deal_id, document_id, kind, stripe_customer_id, stripe_invoice_id, amount_cents, status, hosted_url, mismatch, created_at, paid_at)
       VALUES ('inv_old', ?, ?, ?, 'deposit', 'cus_old', 'in_old', 199850, 'paid', 'https://invoice.stripe.com/i/old', NULL, '2026-12-01T10:00:00.000Z', '2026-12-02T10:00:00.000Z')`,
    ).bind(s.businessId, s.dealId, s.documentId).run();

    for (const q of m0057.queries) await env.DB.prepare(q).run();

    const inv = (await getInvoice(env.DB, "inv_old"))!;
    expect(inv).toMatchObject({
      kind: "deposit", ref: `deposit:${s.documentId}`, description: "Deposit", status: "paid", amountCents: 199850, test: true, stripeCustomerId: "cus_old", stripeInvoiceId: "in_old",
      hostedUrl: "https://invoice.stripe.com/i/old", paidAt: "2026-12-02T10:00:00.000Z", createdAt: "2026-12-01T10:00:00.000Z",
      projectId: null, changeOrderId: null, subscriptionId: null, dueOn: null, failedOn: null, lines: [{ description: "Deposit", amountCents: 199850 }],
    });
    expect(inv.sentAt).toBe("2026-12-01T10:00:00.000Z");
    expect(await getInvoiceForDocument(env.DB, s.documentId)).toEqual(inv);
    expect(await getInvoiceByStripeId(env.DB, "in_old")).toEqual(inv);
    const settings = await env.DB.prepare(`SELECT billing_config FROM settings WHERE id = 1`).first<{ billing_config: string }>();
    expect(settings!.billing_config).toBe("{}");
  });
});
