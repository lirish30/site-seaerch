import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EPOCH, EVENT_LEASE_MS, claimEvent, finishEvent, getInvoiceByStripeId, getInvoiceForDocument, getStripeCustomer, insertInvoice, markInvoice, recordEvent, releaseEvent, saveStripeCustomer,
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
});
