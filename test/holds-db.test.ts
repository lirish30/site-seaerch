import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activeHolds, holdFreeSql, isOnHold, liftHold, liftHoldsForInvoice, placeHold } from "../src/worker/db/holds";
import { markInvoice } from "../src/worker/db/invoices";
import { openInvoice, seedDraft } from "./fixtures/billing";

const NOW = "2026-12-10T10:00:00.000Z";
const LATER = "2026-12-12T10:00:00.000Z";

/** A real invoice that was sent and is unpaid: the only kind that can be held. */
const seedOpen = async (o: Parameters<typeof seedDraft>[0] = {}) => { const s = await seedDraft(o); return { ...s, invoice: await openInvoice(s.invoice) }; };

describe("billing holds", () => {
  it("placeHold for a draft, paid, void or uncollectible invoice makes no row, and for an open or failed one it does", async () => {
    const rows = async (id: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM billing_holds WHERE invoice_id = ?`).bind(id).first<{ n: number }>())!.n;
    const draft = await seedDraft();
    expect(await placeHold(env.DB, { businessId: draft.businessId, invoiceId: draft.invoice.id, now: NOW }), "draft").toBe(false);
    expect(await rows(draft.invoice.id)).toBe(0);
    for (const status of ["paid", "void", "uncollectible"] as const) {
      const s = await seedDraft();
      const inv = await openInvoice(s.invoice);
      await markInvoice(env.DB, inv.id, { status }); // a payment or a void that landed after the sweep read its list
      expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: inv.id, now: NOW }), status).toBe(false);
      expect(await rows(inv.id), status).toBe(0);
    }
    for (const status of ["open", "failed"] as const) {
      const s = await seedDraft();
      const inv = await openInvoice(s.invoice);
      if (status === "failed") await markInvoice(env.DB, inv.id, { status });
      expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: inv.id, now: NOW }), status).toBe(true);
      expect(await rows(inv.id), status).toBe(1);
    }
  });

  it("placeHold twice for one invoice makes one", async () => {
    const s = await seedOpen();
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice.id, now: NOW })).toBe(true);
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice.id, now: LATER })).toBe(false);
    const rows = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM billing_holds WHERE invoice_id = ?`).bind(s.invoice.id).first<{ n: number }>())!;
    expect(rows.n).toBe(1);
    // Once lifted, the invoice's hold is spent: it is not placed again.
    await liftHoldsForInvoice(env.DB, s.invoice.id, "payment", LATER);
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice.id, now: LATER })).toBe(false);
  });

  it("lifting by payment lifts only that invoice's hold", async () => {
    const a = await seedOpen();
    const b = await seedOpen({ seed: a });
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: a.invoice.id, now: NOW });
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: b.invoice.id, now: NOW });
    expect(await liftHoldsForInvoice(env.DB, a.invoice.id, "payment", LATER)).toBe(1);
    expect(await liftHoldsForInvoice(env.DB, a.invoice.id, "payment", LATER)).toBe(0);
    const open = await activeHolds(env.DB, a.businessId);
    expect(open.map((h) => h.invoiceId)).toEqual([b.invoice.id]);
    expect(open[0]).toMatchObject({ businessId: a.businessId, placedAt: NOW, liftedAt: null, liftedBy: null });
    expect(typeof open[0].businessName).toBe("string");
    expect(await isOnHold(env.DB, a.businessId)).toBe(true);
    expect(await liftHoldsForInvoice(env.DB, b.invoice.id, "void", LATER)).toBe(1);
    expect(await isOnHold(env.DB, a.businessId)).toBe(false);
    const lifted = await env.DB.prepare(`SELECT lifted_by FROM billing_holds WHERE invoice_id = ?`).bind(a.invoice.id).first<{ lifted_by: string }>();
    expect(lifted!.lifted_by).toBe("payment");
  });

  it("isOnHold is true while any hold is open", async () => {
    const a = await seedOpen();
    const b = await seedOpen({ seed: a });
    expect(await isOnHold(env.DB, a.businessId)).toBe(false);
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: a.invoice.id, now: NOW });
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: b.invoice.id, now: NOW });
    await liftHoldsForInvoice(env.DB, a.invoice.id, "payment", LATER);
    expect(await isOnHold(env.DB, a.businessId)).toBe(true);
    const mine = (await activeHolds(env.DB, a.businessId))[0];
    expect(await liftHold(env.DB, mine.id, "manual", LATER)).toBe(true);
    expect(await liftHold(env.DB, mine.id, "manual", LATER)).toBe(false);
    expect(await isOnHold(env.DB, a.businessId)).toBe(false);
    expect(await liftHold(env.DB, "missing", "manual", LATER)).toBe(false);
  });

  it("activeHolds without a business lists every open hold, oldest first", async () => {
    const a = await seedOpen();
    const b = await seedOpen();
    await placeHold(env.DB, { businessId: b.businessId, invoiceId: b.invoice.id, now: LATER });
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: a.invoice.id, now: NOW });
    const all = (await activeHolds(env.DB)).filter((h) => h.invoiceId === a.invoice.id || h.invoiceId === b.invoice.id);
    expect(all.map((h) => h.invoiceId)).toEqual([a.invoice.id, b.invoice.id]);
  });

  it("holdFreeSql filters a projects query", async () => {
    const held = await seedOpen();
    const free = await seedOpen();
    const mk = async (businessId: string) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO projects (id, business_id, kind, name, started_at, created_at, updated_at) VALUES (?, ?, 'build', 'Site', ?, ?, ?)`,
      ).bind(id, businessId, NOW, NOW, NOW).run();
      return id;
    };
    const pHeld = await mk(held.businessId), pFree = await mk(free.businessId);
    await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice.id, now: NOW });
    const rows = (await env.DB.prepare(`SELECT p.id FROM projects p WHERE p.id IN (?, ?) AND ${holdFreeSql("p")}`).bind(pHeld, pFree).all<{ id: string }>()).results;
    expect(rows.map((r) => r.id)).toEqual([pFree]);
  });
});
