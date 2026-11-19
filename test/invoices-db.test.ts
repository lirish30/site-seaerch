import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  forgetEvent, getInvoiceByStripeId, getInvoiceForDocument, getStripeCustomer, insertInvoice, markInvoice, recordEvent, saveStripeCustomer,
} from "../src/worker/db/invoices";
import { seedInvoice } from "./fixtures/stripe";
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

  it("recordEvent is false on a repeat, and forgetEvent lets it be recorded again", async () => {
    expect(await recordEvent(env.DB, "evt_dup", "invoice.paid")).toBe(true);
    expect(await recordEvent(env.DB, "evt_dup", "invoice.paid")).toBe(false);
    await forgetEvent(env.DB, "evt_dup");
    expect(await recordEvent(env.DB, "evt_dup", "invoice.paid")).toBe(true);
  });

  it("a business keeps the first Stripe customer saved for it", async () => {
    const s = await seedDeal();
    expect(await getStripeCustomer(env.DB, s.businessId)).toBeNull();
    expect(await saveStripeCustomer(env.DB, s.businessId, "cus_first")).toBe("cus_first");
    expect(await saveStripeCustomer(env.DB, s.businessId, "cus_second")).toBe("cus_first");
    expect(await getStripeCustomer(env.DB, s.businessId)).toBe("cus_first");
  });
});
