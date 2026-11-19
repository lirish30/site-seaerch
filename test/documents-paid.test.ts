import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createApproval } from "../src/worker/db/approvals";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal, moveDeal, type DealStage } from "../src/worker/db/deals";
import { createDraft, getDocument, signDocument } from "../src/worker/db/documents";
import { getInvoiceByStripeId, insertInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { checkConflict } from "../src/worker/conflict";
import { onInvoicePaid } from "../src/worker/documents/deposit";
import { setMailDeps } from "../src/worker/mail/deps";
import { handleStripeEvent } from "../src/worker/stripe/webhook";
import type { Env } from "../src/worker/env";
import { clientSig, proposal, readyToSend, seedDeal, sendDraft } from "./fixtures/documents";
import { SECRET, invoiceEvent, sign } from "./fixtures/stripe";

const FAR = "2099-01-01T00:00:00.000Z";
const AMOUNT = 199850;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** A signed proposal with its deposit invoice, on a deal at `stage` (a lead that has been mailed: one live enrollment with an email waiting for approval). */
async function seed(o: { test?: boolean; stage?: DealStage } = {}) {
  const s = await seedDeal();
  const stage = o.stage ?? "proposal_sent";
  if (stage === "lost") await moveDeal(env.DB, s.dealId, "lost", { lostReason: "went quiet" });
  else await moveDeal(env.DB, s.dealId, stage);
  const content = proposal();
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
  const invoice = await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1",
    stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, amountCents: AMOUNT, hostedUrl: "https://invoice.stripe.com/i/x",
  });
  const enrollmentId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_step)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(enrollmentId, s.businessId, "camp", "outreach", "pat@ace.test", "active", 1, "2026-12-03T00:00:00.000Z", "2026-11-20T00:00:00.000Z", 0).run();
  const approval = await createApproval(env.DB, { kind: "email.send", title: "Step 2", preview: "Hi", payload: { businessId: s.businessId, stepIndex: 1, enrollmentId }, record_type: "enrollment", record_id: enrollmentId, drafted_by: "job" });
  return { ...s, doc, invoice, enrollmentId, approvalId: approval.id };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** One delivery of an event through the real route, so the production `onPaid` wiring is what runs. */
async function deliver(event: unknown, over: Partial<Env> = {}): Promise<number> {
  const body = JSON.stringify(event);
  const res = await worker.fetch(new Request("https://x/hooks/stripe", { method: "POST", body, headers: { "stripe-signature": await sign(body) } }), { ...env, STRIPE_WEBHOOK_SECRET: SECRET, ...over } as Env, createExecutionContext());
  return res.status;
}
const paid = (s: Seeded) => invoiceEvent("invoice.paid", s.invoice);
const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const enrollment = (id: string) => env.DB.prepare(`SELECT status, stopped_reason FROM enrollments WHERE id = ?`).bind(id).first();
const approvalStatus = async (id: string) => (await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(id).first<{ status: string }>())!.status;

describe("invoice.paid for a deposit", () => {
  it("invoice.paid on a proposal_sent deal moves it to won, sets the lead won and stops outreach", async () => {
    const mail = await readyToSend();
    const s = await seed();
    expect(await deliver(paid(s))).toBe(200);

    expect(await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId)).toMatchObject({ status: "paid" });
    const doc = (await getDocument(env.DB, s.doc.id))!;
    expect(doc.paidAt).toMatch(/^\d{4}-/);
    expect(doc.status).toBe("signed");
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "won", closedAt: expect.any(String) });
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).toBe("won");
    expect(await enrollment(s.enrollmentId)).toEqual({ status: "stopped", stopped_reason: "manual" });
    expect(await approvalStatus(s.approvalId)).toBe("rejected");

    expect(await activity(s.businessId, "deposit_paid")).toEqual(["Deposit $1998.50 paid (SL-ABCDEF v1)"]);
    expect(await activity(s.businessId, "deal_moved")).toEqual(["proposal_sent -> won (deposit paid, SL-ABCDEF v1)"]);
    expect(await activity(s.businessId, "status")).toEqual([expect.stringMatching(/→ won$/)]);
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual([]);
    expect(mail.sent).toEqual([]); // the gated sender is never asked to mail a client that has just become one
  });

  it("a test document marks paid and leaves the deal, the lead and the outreach alone", async () => {
    const s = await seed({ test: true });
    expect(await deliver(paid(s))).toBe(200);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).not.toBeNull();
    expect(await activity(s.businessId, "deposit_paid")).toEqual(["Deposit $1998.50 paid (SL-ABCDEF v1), test copy"]);
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "proposal_sent", closedAt: null });
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).not.toBe("won");
    expect(await enrollment(s.enrollmentId)).toMatchObject({ status: "active" });
    expect(await approvalStatus(s.approvalId)).toBe("pending");
    expect(await activity(s.businessId, "deal_moved")).toEqual([]);
    expect((await activity(s.businessId, "note")).filter((n) => /check it|Outreach stopped/.test(n))).toEqual([]);
  });

  it("a deal already lost gets a note and is not reopened", async () => {
    const s = await seed({ stage: "lost" });
    expect(await deliver(paid(s))).toBe(200);
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "lost", lostReason: "went quiet" });
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).not.toBe("won");
    expect(await enrollment(s.enrollmentId)).toMatchObject({ status: "active" });
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual(["deposit paid but the deal is lost: check it"]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).not.toBeNull(); // the money was taken: the document says so
    expect(await activity(s.businessId, "deposit_paid")).toHaveLength(1);
  });

  it("a deal that is already won gets the same note, and nothing else is touched", async () => {
    const s = await seed({ stage: "won" });
    expect(await deliver(paid(s))).toBe(200);
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual(["deposit paid but the deal is won: check it"]);
    expect(await enrollment(s.enrollmentId)).toMatchObject({ status: "active" });
    expect(await activity(s.businessId, "deal_moved")).toEqual([]);
  });

  it("a duplicate webhook delivery moves the deal once", async () => {
    const s = await seed();
    const evt = paid(s);
    expect(await deliver(evt)).toBe(200);
    const closedAt = (await getDeal(env.DB, s.dealId))!.closedAt;
    expect(await deliver(evt)).toBe(200);
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "won", closedAt });
    expect(await activity(s.businessId, "deal_moved")).toHaveLength(1);
    expect(await activity(s.businessId, "deposit_paid")).toHaveLength(1);
  });

  it("a second event for the same payment, or the work run again, changes nothing more", async () => {
    const s = await seed();
    expect(await deliver(paid(s))).toBe(200);
    const before = await listActivity(env.DB, s.businessId, 200);
    const doc = (await getDocument(env.DB, s.doc.id))!;
    expect(await deliver(paid(s))).toBe(200); // another event id, the same invoice
    const row = (await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId)) as InvoiceRow;
    await onInvoicePaid(env, row);
    await onInvoicePaid(env, row);
    expect((await listActivity(env.DB, s.businessId, 200)).map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBe(doc.paidAt);
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual([]);
  });

  it("a paid event for a document of another deal is a mismatch and moves nothing", async () => {
    const mine = await seed();
    const other = await seed();
    const out = await handleStripeEvent(env, invoiceEvent("invoice.paid", mine.invoice, { object: { metadata: { document_id: other.doc.id, kind: "deposit" } } }), { onPaid: onInvoicePaid });
    expect(out).toBe("mismatch");
    for (const s of [mine, other]) {
      expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "proposal_sent" });
      expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeNull();
      expect((await getBusiness(env.DB, s.businessId))!.lead_status).not.toBe("won");
    }
    expect(await getInvoiceByStripeId(env.DB, mine.invoice.stripeInvoiceId)).toMatchObject({ status: "open", paidAt: null });
  });

  it("a failure part-way is finished by the retry of the same event, and the deal moves once", async () => {
    const s = await seed();
    // The lead cannot be written: the deal has not moved yet, so the retry still finds it at proposal_sent.
    await env.DB.exec(`CREATE TRIGGER fail_won BEFORE UPDATE OF lead_status ON businesses WHEN NEW.lead_status = 'won' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const evt = paid(s);
    try { expect(await deliver(evt)).toBe(500); }
    finally { await env.DB.exec(`DROP TRIGGER fail_won`); }
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "proposal_sent" });
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeNull(); // not marked paid until all of it is done

    expect(await deliver(evt)).toBe(200);
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "won" });
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).toBe("won");
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).not.toBeNull();
    expect(await activity(s.businessId, "deal_moved")).toHaveLength(1);
    expect(await activity(s.businessId, "deposit_paid")).toHaveLength(1);
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual([]);
  });

  it("the deal being lost between the read and the move is a note, not an error", async () => {
    const s = await seed();
    // The owner marks the deal lost the instant the lead is written, which is the last write before the move.
    await env.DB.exec(`CREATE TRIGGER lose_deal AFTER UPDATE OF lead_status ON businesses WHEN NEW.lead_status = 'won' BEGIN UPDATE deals SET stage = 'lost', lost_reason = 'raced', closed_at = '2026-12-03T00:00:00.000Z' WHERE id = '${s.dealId}'; END`);
    try { expect(await deliver(paid(s))).toBe(200); }
    finally { await env.DB.exec(`DROP TRIGGER lose_deal`); }
    expect(await getDeal(env.DB, s.dealId)).toMatchObject({ stage: "lost" });
    expect((await activity(s.businessId, "note")).filter((n) => /check it/.test(n))).toEqual(["deposit paid but the deal is lost: check it"]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).not.toBeNull();
  });

  it("after won the lead is blocked by the conflict gate as an existing client", async () => {
    const s = await seed();
    expect(await checkConflict(env.DB, { email: "pat@ace.test", businessId: s.businessId })).toEqual({ blocked: false });
    expect(await deliver(paid(s))).toBe(200);
    expect(await checkConflict(env.DB, { email: "pat@ace.test", businessId: s.businessId })).toMatchObject({ blocked: true, source: "client", reason: expect.stringContaining("existing client") });
  });
});
