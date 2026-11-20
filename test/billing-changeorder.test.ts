import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as draft from "../src/worker/billing/draft";
import { invoiceChangeOrder } from "../src/worker/billing/changeOrderInvoice";
import { approve } from "../src/worker/approvals/decide";
import { afterSigned, draftChangeOrder, markChangeOrderPaid } from "../src/worker/changeorders/service";
import { ChangeOrderStateError, getChangeOrder, signChangeOrder } from "../src/worker/db/changeOrders";
import { listActivity } from "../src/worker/db/activity";
import { getInvoiceByRef, listInvoices, markInvoice } from "../src/worker/db/invoices";
import { getPackage, savePackage } from "../src/worker/db/packages";
import { setProjectStatus } from "../src/worker/db/projects";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { clientSig, seal } from "./fixtures/changeorders";
import { readyToSend } from "./fixtures/documents";
import { seedProject } from "./fixtures/projects";

const e = env as Env;
const NOW = new Date("2026-12-06T12:00:00.000Z");
let errors: ReturnType<typeof vi.spyOn>;
let mail: Awaited<ReturnType<typeof readyToSend>>;
beforeEach(async () => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); mail = await readyToSend(); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); vi.restoreAllMocks(); setMailDeps(null); });

const base = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan" as const };
const waiting = async (invoiceId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'invoice.send' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoiceId).all<{ id: string }>()).results;

/** A drafted order, sent and signed by the client (not yet paid). */
async function signedOrder(o: { test?: boolean; priceCents?: number } = {}) {
  const s = await seedProject({ test: o.test });
  const d = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 2, ...(o.priceCents ? { priceCents: o.priceCents } : {}) });
  const sent = await seal(d);
  expect(await signChangeOrder(env.DB, sent.id, clientSig(sent.contentSha256!), NOW.toISOString())).toBe("signed");
  return { ...s, id: sent.id, reference: sent.content.reference };
}

describe("change-order invoices", () => {
  it("signing a real change order drafts one invoice and one approval, replays make no more", async () => {
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    await afterSigned(e, s.id, NOW);
    const all = (await listInvoices(env.DB, { kinds: ["change_order"] })).filter((i) => i.changeOrderId === s.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "change_order", status: "draft", ref: `co:${s.id}`, test: false, businessId: s.businessId, dealId: s.dealId, projectId: s.project.id, documentId: s.documentId,
      changeOrderId: s.id, subscriptionId: null, stripeInvoiceId: null, amountCents: 25000,
    });
    expect(await waiting(all[0].id)).toHaveLength(1);
    // Calling it by hand is the same invoice and the same approval.
    const again = await invoiceChangeOrder(e, s.id);
    expect(again.invoice.id).toBe(all[0].id);
    expect(again.approval?.id).toBe((await waiting(all[0].id))[0].id);
    expect(await waiting(all[0].id)).toHaveLength(1);
  });

  it("a test change order is not invoiced", async () => {
    const s = await signedOrder({ test: true });
    await afterSigned(e, s.id, NOW);
    expect(await getInvoiceByRef(env.DB, `co:${s.id}`)).toBeNull();
    await expect(invoiceChangeOrder(e, s.id)).rejects.toThrow("A test change order is not invoiced.");
    await expect(invoiceChangeOrder(e, s.id)).rejects.toBeInstanceOf(ChangeOrderStateError);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a change order that is paid by hand cannot be invoiced", async () => {
    const s = await signedOrder();
    await markChangeOrderPaid(e, s.id, { via: "manual", now: NOW });
    await expect(invoiceChangeOrder(e, s.id)).rejects.toThrow("This change order is already paid, so it cannot be invoiced.");
    await afterSigned(e, s.id, NOW);
    expect(await getInvoiceByRef(env.DB, `co:${s.id}`)).toBeNull();
  });

  it("a change order that is not signed, or on a cancelled project, cannot be invoiced", async () => {
    const s = await seedProject();
    const d = await draftChangeOrder(e, { ...base, projectId: s.project.id, hours: 1 });
    await expect(invoiceChangeOrder(e, d.id)).rejects.toThrow("This change order has not been signed, so it cannot be invoiced.");
    await expect(invoiceChangeOrder(e, "no-such-order")).rejects.toThrow("There is no such change order.");
    const t = await signedOrder();
    await setProjectStatus(env.DB, t.project.id, "cancelled");
    await expect(invoiceChangeOrder(e, t.id)).rejects.toThrow("This project is cancelled, so its change order is not invoiced.");
    await afterSigned(e, t.id, NOW);
    expect(await getInvoiceByRef(env.DB, `co:${t.id}`)).toBeNull();
  });

  it("the invoice for a change order is its frozen price", async () => {
    const s = await signedOrder({ priceCents: 31234 });
    const hourly = (await getPackage(env.DB, "hourly"))!;
    await savePackage(env.DB, "hourly", { priceCents: hourly.priceCents + 5000 }); // today's catalog never reaches a signed order
    const { invoice, approval } = await invoiceChangeOrder(e, s.id);
    expect(invoice.amountCents).toBe(31234);
    expect(invoice.lines).toEqual([{ description: `${s.reference}: Add a gallery page`, amountCents: 31234 }]);
    expect(invoice.description).toBe(`${s.reference}: Add a gallery page`);
    expect(approval).toMatchObject({ kind: "invoice.send", status: "pending", record_type: "project", record_id: s.project.id });
  });

  it("a failure drafting the invoice is logged and the signature stands", async () => {
    const s = await signedOrder();
    vi.spyOn(draft, "draftAndPropose").mockRejectedValue(new Error("the database is unhappy"));
    await expect(afterSigned(e, s.id, NOW)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalled();
    expect(String(errors.mock.calls.at(-1))).toContain("the database is unhappy");
    expect((await getChangeOrder(env.DB, s.id))?.status).toBe("signed");
    expect(await getInvoiceByRef(env.DB, `co:${s.id}`)).toBeNull();
  });
});

describe("a change order paid by hand while its Stripe invoice is outstanding", () => {
  it("marking it paid by hand is refused while the invoice is a draft, open or failed, and allowed once it is void or when there is none", async () => {
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    const inv = (await getInvoiceByRef(env.DB, `co:${s.id}`))!;
    const refusal = "Void or discard this change order's invoice first, then mark it paid.";
    await expect(markChangeOrderPaid(e, s.id, { via: "manual", now: NOW })).rejects.toThrow(refusal); // draft
    await expect(markChangeOrderPaid(e, s.id, { via: "manual", now: NOW })).rejects.toBeInstanceOf(ChangeOrderStateError);
    await env.DB.prepare(`UPDATE invoices SET status = 'open' WHERE id = ?`).bind(inv.id).run();
    await expect(markChangeOrderPaid(e, s.id, { via: "manual", now: NOW })).rejects.toThrow(refusal);
    await env.DB.prepare(`UPDATE invoices SET status = 'failed' WHERE id = ?`).bind(inv.id).run();
    await expect(markChangeOrderPaid(e, s.id, { via: "manual", now: NOW })).rejects.toThrow(refusal);
    expect((await getChangeOrder(env.DB, s.id))!.paidAt).toBeNull();
    // Stripe's own payment is never refused, and a voided invoice is no longer owed.
    expect(await markInvoice(env.DB, inv.id, { status: "void" })).toBe(true);
    expect(await markChangeOrderPaid(e, s.id, { via: "manual", now: NOW })).toMatchObject({ paidVia: "manual" });
  });

  it("approving the invoice send of an order that was paid meanwhile sends nothing and says so on the timeline", async () => {
    const s = await signedOrder();
    await afterSigned(e, s.id, NOW);
    const inv = (await getInvoiceByRef(env.DB, `co:${s.id}`))!;
    const [a] = await waiting(inv.id);
    await env.DB.prepare(`UPDATE change_orders SET paid_at = ?, paid_via = 'manual' WHERE id = ?`).bind(NOW.toISOString(), s.id).run(); // paid by hand after the invoice was drafted
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect((await getInvoiceByRef(env.DB, `co:${s.id}`))!.status).toBe("draft"); // never made at Stripe
    const notes = (await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("not sent") && x.detail.includes(`co:${s.id}`));
    expect(notes).toHaveLength(1);
    expect(notes[0].detail).toContain("already paid");
  });
});
