import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAnyInvoicePaid } from "../src/worker/billing/paid";
import { mirrorSubscriptionInvoice, subscriptionCheckoutCompleted, subscriptionUpdated } from "../src/worker/billing/mirror";
import { milestoneInvoice } from "../src/worker/billing/milestones";
import { draftChangeOrder, voidDraftOrSent } from "../src/worker/changeorders/service";
import { listActivity } from "../src/worker/db/activity";
import { getChangeOrder, signChangeOrder } from "../src/worker/db/changeOrders";
import { activeHolds, placeHold } from "../src/worker/db/holds";
import { getInvoice, getInvoiceByStripeId, insertDraftInvoice, listInvoices } from "../src/worker/db/invoices";
import { getSubscription, insertPlanned, markSubscription, type Subscription } from "../src/worker/db/subscriptions";
import { listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { handleStripeEvent, paidProblem } from "../src/worker/stripe/webhook";
import { openInvoice, refEvent, seedDoc, seedSignedProject } from "./fixtures/billing";
import { clientSig, seal } from "./fixtures/changeorders";
import { readyToSend } from "./fixtures/documents";
import { seedProject } from "./fixtures/projects";
import { invoiceEvent } from "./fixtures/stripe";

const e = env as Env;
const deps = { onPaid: onAnyInvoicePaid };
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

const logs = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const byStripe = async (id: string | null) => (await getInvoiceByStripeId(env.DB, id!))!;

/** An open milestone invoice from a signed and paid proposal. */
async function milestone(over: { option?: "b" | "c"; m?: "site_finished" | "design_approved" } = {}) {
  const s = await seedSignedProject({ option: over.option });
  const draft = (await milestoneInvoice(e, s.project, over.m ?? "site_finished"))!;
  return { ...s, invoice: await openInvoice(draft) };
}

describe("paidProblem", () => {
  it("a deposit is matched on its document, every other kind on its own ref", async () => {
    const m = await milestone();
    const ok = { amount_paid: m.invoice.amountCents, currency: "usd" };
    expect(paidProblem(m.invoice, { ...ok, metadata: { ref: m.invoice.ref } })).toBeNull();
    // the document alone does not say which of its invoices this is
    expect(paidProblem(m.invoice, { ...ok, metadata: { document_id: m.documentId } })).toMatch(/ref/);
    expect(paidProblem(m.invoice, { ...ok, metadata: { ref: `milestone:${m.documentId}:design_approved` } })).toMatch(/ref/);
    expect(paidProblem(m.invoice, { ...ok, metadata: undefined })).toMatch(/ref/);
    const deposit = { ...m.invoice, kind: "deposit" as const, ref: `deposit:${m.documentId}` };
    expect(paidProblem(deposit, { ...ok, metadata: { document_id: m.documentId } })).toBeNull();
    expect(paidProblem(deposit, { ...ok, metadata: { ref: deposit.ref } })).toMatch(/document/);
  });
});

describe("paid invoices of every kind", () => {
  it("a paid milestone invoice is marked paid and logs once", async () => {
    const m = await milestone();
    const evt = refEvent("invoice.paid", m.invoice);
    expect(await handleStripeEvent(env, evt, deps)).toBe("applied");
    expect(await byStripe(m.invoice.stripeInvoiceId)).toMatchObject({ status: "paid", mismatch: null });
    expect((await byStripe(m.invoice.stripeInvoiceId)).paidAt).toMatch(/^\d{4}-/);
    const lines = await logs(m.businessId, "invoice_paid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(m.invoice.ref);
    // the same payment announced again (another event id) logs nothing more and keeps the first paid time
    const first = (await byStripe(m.invoice.stripeInvoiceId)).paidAt;
    expect(await handleStripeEvent(env, refEvent("invoice.paid", m.invoice), deps)).toBe("applied");
    expect(await logs(m.businessId, "invoice_paid")).toHaveLength(1);
    expect((await byStripe(m.invoice.stripeInvoiceId)).paidAt).toBe(first);
    // a milestone is not a deposit: the document's deposit is untouched
    expect(await logs(m.businessId, "deposit_paid")).toEqual([]);
  });

  it("hourly and early-exit invoices log once as well", async () => {
    const s = await seedDoc();
    for (const kind of ["hourly", "early_exit"] as const) {
      const { invoice } = await insertDraftInvoice(env.DB, {
        businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, changeOrderId: null, subscriptionId: null,
        kind, ref: `${kind}:${crypto.randomUUID()}`, test: false, description: `A ${kind} invoice`, lines: [{ description: "Work", amountCents: 45000 }],
      });
      const open = await openInvoice(invoice);
      await handleStripeEvent(env, refEvent("invoice.paid", open), deps);
      await handleStripeEvent(env, refEvent("invoice.paid", open), deps);
    }
    expect(await logs(s.businessId, "invoice_paid")).toHaveLength(2);
  });

  /** A signed change order with two locked tasks, and its open invoice. */
  async function changeOrderInvoice(o: { voided?: boolean } = {}) {
    const s = await seedProject();
    const draft = await draftChangeOrder(e, { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan", projectId: s.project.id, hours: 2, deliverables: ["Build the page", "Add the photos"] });
    const sent = await seal(draft);
    if (!o.voided) expect(await signChangeOrder(env.DB, sent.id, clientSig(sent.contentSha256!), "2026-12-06T09:00:00.000Z")).toBe("signed");
    else await voidDraftOrSent(e, sent.id, "the client changed their mind", new Date());
    const { invoice } = await insertDraftInvoice(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: s.project.id, changeOrderId: sent.id, subscriptionId: null,
      kind: "change_order", ref: `change_order:${sent.id}`, test: false, description: "Add a gallery page", lines: [{ description: "Add a gallery page", amountCents: sent.content.priceCents }],
    });
    return { ...s, coId: sent.id, invoice: await openInvoice(invoice) };
  }
  const tasksOf = async (projectId: string, coId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.changeOrderId === coId);

  it("a paid change-order invoice marks the order paid through stripe and unlocks its tasks once, also when the event is replayed", async () => {
    const s = await changeOrderInvoice();
    expect((await tasksOf(s.project.id, s.coId)).map((t) => t.status)).toEqual(["locked", "locked"]);
    expect(await handleStripeEvent(env, refEvent("invoice.paid", s.invoice), deps)).toBe("applied");
    expect(await getChangeOrder(env.DB, s.coId)).toMatchObject({ status: "signed", paidVia: "stripe" });
    expect((await getChangeOrder(env.DB, s.coId))!.paidAt).not.toBeNull();
    expect((await tasksOf(s.project.id, s.coId)).map((t) => t.status)).toEqual(["todo", "todo"]);
    expect(await logs(s.businessId, "change_order_paid")).toHaveLength(1);
    // replays: the same event, and the same payment under a new event id
    const evt = refEvent("invoice.paid", s.invoice);
    await handleStripeEvent(env, evt, deps);
    expect(await handleStripeEvent(env, evt, deps)).toBe("duplicate");
    expect((await tasksOf(s.project.id, s.coId)).map((t) => t.status)).toEqual(["todo", "todo"]);
    expect(await logs(s.businessId, "change_order_paid")).toHaveLength(1);
    // the order's own line is the log: this invoice adds no invoice_paid line
    expect(await logs(s.businessId, "invoice_paid")).toEqual([]);
    // the deposit is not involved
    expect(await logs(s.businessId, "deposit_paid")).toEqual([]);
  });

  it("a paid event for a change order that was voided is noted and does not throw", async () => {
    const s = await changeOrderInvoice({ voided: true });
    expect(await handleStripeEvent(env, refEvent("invoice.paid", s.invoice), deps)).toBe("applied");
    expect(await byStripe(s.invoice.stripeInvoiceId)).toMatchObject({ status: "paid" });
    expect((await getChangeOrder(env.DB, s.coId))!.paidAt).toBeNull();
    expect((await tasksOf(s.project.id, s.coId)).map((t) => t.status)).toEqual(["skipped", "skipped"]);
    const notes = await logs(s.businessId, "note");
    expect(notes.filter((n) => n.includes("change order") && n.includes(s.invoice.ref))).toHaveLength(1);
    // run again (a new event for the same payment): still one note
    await handleStripeEvent(env, refEvent("invoice.paid", s.invoice), deps);
    expect((await logs(s.businessId, "note")).filter((n) => n.includes(s.invoice.ref))).toHaveLength(1);
  });

  it("a paid amount that is not the invoiced cents records a mismatch and unlocks nothing", async () => {
    const s = await changeOrderInvoice();
    const evt = refEvent("invoice.paid", s.invoice, { amount_paid: s.invoice.amountCents - 1 });
    expect(await handleStripeEvent(env, evt, deps)).toBe("mismatch");
    expect(await byStripe(s.invoice.stripeInvoiceId)).toMatchObject({ status: "open", paidAt: null });
    expect((await byStripe(s.invoice.stripeInvoiceId)).mismatch).toMatch(/amount/);
    expect((await getChangeOrder(env.DB, s.coId))!.paidAt).toBeNull();
    expect((await tasksOf(s.project.id, s.coId)).map((t) => t.status)).toEqual(["locked", "locked"]);
    expect(await logs(s.businessId, "change_order_paid")).toEqual([]);
    expect(await logs(s.businessId, "invoice_paid")).toEqual([]);
  });

  it("a part payment, another currency and another invoice's ref are each a mismatch", async () => {
    const m = await milestone();
    const other = await milestone({ option: "c", m: "design_approved" });
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["part payment", { amount_paid: Math.floor(m.invoice.amountCents / 2) }, /amount/],
      ["another currency", { currency: "eur" }, /currency/],
      ["another invoice's ref", { metadata: { ref: other.invoice.ref, document_id: m.documentId } }, /ref/],
    ];
    for (const [label, object, why] of cases) {
      expect(await handleStripeEvent(env, refEvent("invoice.paid", m.invoice, object), deps), label).toBe("mismatch");
      const row = await byStripe(m.invoice.stripeInvoiceId);
      expect(row, label).toMatchObject({ status: "open", paidAt: null });
      expect(row.mismatch, label).toMatch(why);
    }
    expect(await logs(m.businessId, "invoice_paid")).toEqual([]);
  });

  it("a milestone invoice's metadata ref that belongs to another invoice is a mismatch", async () => {
    const m = await milestone({ option: "c", m: "design_approved" });
    const sibling = `milestone:${m.documentId}:site_finished`;
    expect(await handleStripeEvent(env, refEvent("invoice.paid", m.invoice, { metadata: { ref: sibling, document_id: m.documentId } }), deps)).toBe("mismatch");
    // the document id alone, with no ref, is not enough either
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", m.invoice, { object: { metadata: { document_id: m.documentId, kind: "deposit" } } }), deps)).toBe("mismatch");
    expect(await byStripe(m.invoice.stripeInvoiceId)).toMatchObject({ status: "open", paidAt: null });
    // the right ref pays it
    expect(await handleStripeEvent(env, refEvent("invoice.paid", m.invoice), deps)).toBe("applied");
    expect((await byStripe(m.invoice.stripeInvoiceId)).status).toBe("paid");
  });

  it("a paid event lifts that invoice's hold only", async () => {
    const a = await milestone(), b = await milestone();
    for (const x of [a, b]) expect(await placeHold(env.DB, { businessId: x.businessId, invoiceId: x.invoice.id, now: "2027-01-10T00:00:00.000Z" })).toBe(true);
    expect(await handleStripeEvent(env, refEvent("invoice.paid", a.invoice), deps)).toBe("applied");
    const held = (await activeHolds(env.DB)).map((h) => h.invoiceId);
    expect(held).toContain(b.invoice.id);
    expect(held).not.toContain(a.invoice.id);
    // a mismatch lifts nothing
    expect(await handleStripeEvent(env, refEvent("invoice.paid", b.invoice, { amount_paid: 1 }), deps)).toBe("mismatch");
    expect((await activeHolds(env.DB)).map((h) => h.invoiceId)).toContain(b.invoice.id);
  });

  it("a voided invoice at Stripe lifts its hold too", async () => {
    const a = await milestone();
    await placeHold(env.DB, { businessId: a.businessId, invoiceId: a.invoice.id, now: "2027-01-10T00:00:00.000Z" });
    expect(await handleStripeEvent(env, refEvent("invoice.voided", a.invoice), deps)).toBe("applied");
    expect((await byStripe(a.invoice.stripeInvoiceId)).status).toBe("void");
    expect((await activeHolds(env.DB)).map((h) => h.invoiceId)).not.toContain(a.invoice.id);
  });

  it("a deposit still goes through the deposit's own paid handler", async () => {
    const { seedInvoice } = await import("./fixtures/stripe");
    const { invoice, businessId } = await seedInvoice();
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice), deps)).toBe("applied");
    expect(await logs(businessId, "deposit_paid")).toHaveLength(1);
    expect(await logs(businessId, "invoice_paid")).toEqual([]);
  });
});

// ---- subscriptions ----

const sub = async (over: { status?: Subscription["status"]; test?: boolean; session?: string | null; firstChargeOn?: string | null; termMonths?: number | null; stripeId?: string } = {}) => {
  const s = await seedDoc();
  const { subscription } = await insertPlanned(env.DB, {
    businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "website_subscription", packageVersion: 1, monthlyCents: 29900,
    startsWhen: "launch", firstChargeOn: over.firstChargeOn === undefined ? "2027-01-31" : over.firstChargeOn, termMonths: over.termMonths === undefined ? 24 : over.termMonths,
    termEndsOn: null, endAction: "convert_to_care", test: over.test ?? false,
  });
  await markSubscription(env.DB, subscription.id, {
    status: over.status ?? "link_sent", token: `tok_${crypto.randomUUID().slice(0, 8)}`, stripeCustomerId: "cus_1",
    stripeCheckoutSessionId: over.session === undefined ? `cs_${crypto.randomUUID().slice(0, 8)}` : over.session,
    ...(over.stripeId ? { stripeSubscriptionId: over.stripeId } : {}),
  });
  return { ...s, sub: (await getSubscription(env.DB, subscription.id))! };
};
const session = (s: Subscription, over: Record<string, unknown> = {}) => ({
  id: s.stripeCheckoutSessionId, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "no_payment_required",
  client_reference_id: s.id, subscription: `sub_${crypto.randomUUID().slice(0, 8)}`, customer: "cus_1", ...over,
});
const sessionEvent = (obj: Record<string, unknown>) => ({ id: `evt_${crypto.randomUUID().slice(0, 8)}`, type: "checkout.session.completed", data: { object: obj } });
const cycle = (stripeSub: string, over: Record<string, unknown> = {}) => ({
  id: `in_${crypto.randomUUID().slice(0, 8)}`, object: "invoice", subscription: stripeSub, customer: "cus_1", amount_paid: 29900, amount_due: 29900, currency: "usd",
  hosted_invoice_url: "https://invoice.stripe.com/i/cycle", due_date: null, metadata: {}, ...over,
});
const subEvent = (type: string, obj: Record<string, unknown>, id = `evt_${crypto.randomUUID().slice(0, 8)}`) => ({ id, type, data: { object: obj } });

describe("subscription invoices", () => {
  it("a subscription cycle invoice for a known subscription is mirrored once and counted once on replay", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const obj = cycle(s.sub.stripeSubscriptionId!);
    const evt = subEvent("invoice.paid", obj);
    expect(await handleStripeEvent(env, evt, deps)).toBe("applied");
    const row = (await byStripe(obj.id))!;
    expect(row).toMatchObject({
      kind: "subscription", ref: `stripe:${obj.id}`, status: "paid", amountCents: 29900, subscriptionId: s.sub.id, businessId: s.businessId, documentId: s.documentId,
      test: false, mismatch: null, stripeCustomerId: "cus_1", dueOn: null,
    });
    expect(row.paidAt).not.toBeNull();
    expect(row.lines).toEqual([{ description: expect.any(String), amountCents: 29900 }]);
    expect(await logs(s.businessId, "invoice_paid")).toHaveLength(1);
    // the same event again, and the same invoice under another event id
    expect(await handleStripeEvent(env, evt, deps)).toBe("duplicate");
    expect(await handleStripeEvent(env, subEvent("invoice.paid", obj), deps)).toBe("applied");
    expect(await listInvoices(env.DB, { kinds: ["subscription"], businessId: s.businessId })).toHaveLength(1);
    expect(await logs(s.businessId, "invoice_paid")).toHaveLength(1);
  });

  it("a mirrored invoice takes its due date from Stripe's due_date, and a test subscription's invoice is a test row", async () => {
    const s = await sub({ status: "active", test: true, stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const due = Date.UTC(2027, 1, 14, 20, 0, 0) / 1000; // noon in Los Angeles: the 14th there too
    const row = (await mirrorSubscriptionInvoice(e, cycle(s.sub.stripeSubscriptionId!, { due_date: due, amount_paid: 0 }), "invoice.payment_failed"))!;
    expect(row).toMatchObject({ kind: "subscription", dueOn: "2027-02-14", test: true, amountCents: 29900, subscriptionId: s.sub.id });
  });

  it("an invoice for an unknown subscription is ignored", async () => {
    const onPaid = vi.fn(async () => {});
    const obj = cycle("sub_not_ours");
    expect(await mirrorSubscriptionInvoice(e, obj, "invoice.paid")).toBeNull();
    expect(await handleStripeEvent(env, subEvent("invoice.paid", obj), { onPaid })).toBe("ignored");
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", obj), { onPaid })).toBe("ignored");
    expect(onPaid).not.toHaveBeenCalled();
    expect(await getInvoiceByStripeId(env.DB, obj.id)).toBeNull();
  });

  it("a cycle invoice of no money (a trial's first invoice) is ignored, not an error", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const obj = cycle(s.sub.stripeSubscriptionId!, { amount_paid: 0, amount_due: 0 });
    expect(await handleStripeEvent(env, subEvent("invoice.paid", obj), deps)).toBe("ignored");
    expect(await getInvoiceByStripeId(env.DB, obj.id)).toBeNull();
  });

  it("a cycle invoice paid in another amount or currency than Stripe first reported is a mismatch", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const obj = cycle(s.sub.stripeSubscriptionId!, { status: "open", amount_paid: 0 });
    expect(await handleStripeEvent(env, subEvent("invoice.created", obj), deps)).toBe("ignored");
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", obj), deps)).toBe("applied"); // mirrored from amount_due
    expect(await handleStripeEvent(env, subEvent("invoice.paid", { ...obj, amount_paid: 100 }), deps)).toBe("mismatch");
    expect(await handleStripeEvent(env, subEvent("invoice.paid", { ...obj, amount_paid: 29900, currency: "eur" }), deps)).toBe("mismatch");
    expect((await byStripe(obj.id)).status).toBe("failed");
    expect(await handleStripeEvent(env, subEvent("invoice.paid", { ...obj, amount_paid: 29900 }), deps)).toBe("applied");
    expect((await byStripe(obj.id)).status).toBe("paid");
  });

  it("a failed autopay invoice sets failed_on and moves the subscription to past_due; the next paid one moves it back", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const bad = cycle(s.sub.stripeSubscriptionId!, { amount_paid: 0 });
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), deps)).toBe("applied");
    const row = await byStripe(bad.id);
    expect(row).toMatchObject({ kind: "subscription", status: "failed", amountCents: 29900, subscriptionId: s.sub.id });
    expect(row.failedOn).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("past_due");
    // a retry of the same failure (Stripe's next attempt) changes nothing more
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), deps)).toBe("applied");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("past_due");
    expect(await listInvoices(env.DB, { kinds: ["subscription"], businessId: s.businessId })).toHaveLength(1);
    // the same invoice is paid after a retry: it and the subscription recover
    expect(await handleStripeEvent(env, subEvent("invoice.paid", { ...bad, amount_paid: 29900 }), deps)).toBe("applied");
    expect((await byStripe(bad.id)).status).toBe("paid");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
    // a failure announced late for an invoice that is already paid changes nothing
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), deps)).toBe("ignored");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
    // a later month's paid invoice for a subscription that went past_due moves it back
    const next = cycle(s.sub.stripeSubscriptionId!, { amount_paid: 0 });
    await handleStripeEvent(env, subEvent("invoice.payment_failed", next), deps);
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("past_due");
    await handleStripeEvent(env, subEvent("invoice.paid", cycle(s.sub.stripeSubscriptionId!)), deps);
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
  });

  it("a first invoice that arrives before the Checkout is mirrored once; the Checkout then activates the subscription and nothing is duplicated", async () => {
    const s = await sub({ status: "link_sent" });
    const stripeSub = `sub_${crypto.randomUUID().slice(0, 8)}`;
    const obj = cycle(stripeSub, { subscription_details: { metadata: { subscription_id: s.sub.id } }, livemode: false });
    // not an unknown subscription: its own metadata names ours, which has no Stripe subscription yet
    expect(await handleStripeEvent(env, subEvent("invoice.paid", obj), deps)).toBe("applied");
    expect(await byStripe(obj.id)).toMatchObject({ kind: "subscription", status: "paid", subscriptionId: s.sub.id, amountCents: 29900, ref: `stripe:${obj.id}` });
    // the invoice never activates it
    expect(await getSubscription(env.DB, s.sub.id)).toMatchObject({ status: "link_sent", stripeSubscriptionId: null, activatedAt: null });
    expect(await logs(s.businessId, "invoice_paid")).toHaveLength(1);
    // the Checkout arrives: it is the only thing that activates
    const done = sessionEvent(session(s.sub, { subscription: stripeSub }));
    expect(await handleStripeEvent(env, done, deps)).toBe("applied");
    const active = (await getSubscription(env.DB, s.sub.id))!;
    expect(active).toMatchObject({ status: "active", stripeSubscriptionId: stripeSub });
    // both replayed (same ids, and fresh event ids): nothing changes, nothing is added
    expect(await handleStripeEvent(env, done, deps)).toBe("duplicate");
    expect(await handleStripeEvent(env, subEvent("invoice.paid", obj), deps)).toBe("applied");
    expect(await handleStripeEvent(env, sessionEvent(session(s.sub, { subscription: stripeSub })), deps)).toBe("applied");
    expect(await getSubscription(env.DB, s.sub.id)).toEqual(active);
    expect(await listInvoices(env.DB, { kinds: ["subscription"], businessId: s.businessId })).toHaveLength(1);
    expect(await logs(s.businessId, "invoice_paid")).toHaveLength(1);
  });

  it("the newer payload shape (parent.subscription_details) is mirrored, found by Stripe id or by metadata", async () => {
    const known = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const a = cycle("x", { subscription: undefined, parent: { type: "subscription_details", subscription_details: { subscription: known.sub.stripeSubscriptionId, metadata: {} } } });
    expect(await handleStripeEvent(env, subEvent("invoice.paid", a), deps)).toBe("applied");
    expect(await byStripe(a.id)).toMatchObject({ kind: "subscription", status: "paid", subscriptionId: known.sub.id });

    const early = await sub({ status: "link_sent" });
    const stripeSub = `sub_${crypto.randomUUID().slice(0, 8)}`;
    const b = cycle("x", { subscription: undefined, parent: { subscription_details: { subscription: stripeSub, metadata: { subscription_id: early.sub.id } } } });
    expect(await handleStripeEvent(env, subEvent("invoice.paid", b), deps)).toBe("applied");
    expect(await byStripe(b.id)).toMatchObject({ kind: "subscription", subscriptionId: early.sub.id });
    expect((await getSubscription(env.DB, early.sub.id))!.status).toBe("link_sent");
  });

  it("an invoice whose metadata names a subscription that has another Stripe subscription is ignored, and so is a live one for a test subscription", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const other = cycle(`sub_${crypto.randomUUID().slice(0, 8)}`, { subscription_details: { metadata: { subscription_id: s.sub.id } } });
    expect(await handleStripeEvent(env, subEvent("invoice.paid", other), deps)).toBe("ignored");
    expect(await getInvoiceByStripeId(env.DB, other.id)).toBeNull();
    const t = await sub({ status: "link_sent", test: true });
    const live = cycle(`sub_${crypto.randomUUID().slice(0, 8)}`, { livemode: true, subscription_details: { metadata: { subscription_id: t.sub.id } } });
    expect(await handleStripeEvent(env, subEvent("invoice.paid", live), deps)).toBe("ignored");
    expect(await getInvoiceByStripeId(env.DB, live.id)).toBeNull();
    // a metadata id that is no subscription of ours is ignored too
    expect(await handleStripeEvent(env, subEvent("invoice.paid", cycle("sub_zzz", { subscription_details: { metadata: { subscription_id: "nope" } } })), deps)).toBe("ignored");
  });

  it("a later payment_failed (Stripe's retry on another day) keeps the first failed_on; a paid-then-late failure changes nothing", async () => {
    const s = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const bad = cycle(s.sub.stripeSubscriptionId!, { amount_paid: 0 });
    const day = (iso: string) => ({ ...deps, clock: () => new Date(iso) });
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), day("2027-03-01T20:00:00.000Z"))).toBe("applied");
    expect((await byStripe(bad.id)).failedOn).toBe("2027-03-01");
    // the retry three and five days later fails again
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), day("2027-03-04T20:00:00.000Z"))).toBe("applied");
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), day("2027-03-06T20:00:00.000Z"))).toBe("applied");
    expect(await byStripe(bad.id)).toMatchObject({ status: "failed", failedOn: "2027-03-01" });
    // paid, then a late failure: nothing moves, the date stays
    expect(await handleStripeEvent(env, subEvent("invoice.paid", { ...bad, amount_paid: 29900 }), day("2027-03-07T20:00:00.000Z"))).toBe("applied");
    expect(await handleStripeEvent(env, subEvent("invoice.payment_failed", bad), day("2027-03-09T20:00:00.000Z"))).toBe("ignored");
    expect(await byStripe(bad.id)).toMatchObject({ status: "paid", failedOn: "2027-03-01" });
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
  });

  it("a cancelled subscription is not woken by a late paid invoice", async () => {
    const s = await sub({ status: "cancelled", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    await handleStripeEvent(env, subEvent("invoice.paid", cycle(s.sub.stripeSubscriptionId!)), deps);
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("cancelled");
  });
});

describe("checkout.session.completed", () => {
  it("activates the subscription once and sets the term end", async () => {
    const s = await sub({ firstChargeOn: "2027-01-31", termMonths: 24 });
    const obj = session(s.sub);
    const evt = sessionEvent(obj);
    expect(await handleStripeEvent(env, evt, deps)).toBe("applied");
    const active = (await getSubscription(env.DB, s.sub.id))!;
    expect(active).toMatchObject({ status: "active", stripeSubscriptionId: obj.subscription, stripeCustomerId: "cus_1", termEndsOn: "2029-01-31" });
    expect(active.activatedAt).toMatch(/^\d{4}-/);
    // replayed under a new event id: nothing changes
    expect(await handleStripeEvent(env, sessionEvent(obj), deps)).toBe("applied");
    expect(await getSubscription(env.DB, s.sub.id)).toEqual(active);
    expect(await handleStripeEvent(env, evt, deps)).toBe("duplicate");
  });

  it("a paid session (the first charge taken at Checkout) activates too, and the term end clamps to the month's last day", async () => {
    const s = await sub({ firstChargeOn: "2027-08-31", termMonths: 6 });
    await subscriptionCheckoutCompleted(e, session(s.sub, { payment_status: "paid" }));
    expect(await getSubscription(env.DB, s.sub.id)).toMatchObject({ status: "active", termEndsOn: "2028-02-29" });
  });

  it("ignores a session that is not a subscription, not paid, or for another checkout", async () => {
    const s = await sub();
    for (const [label, over] of [
      ["payment mode", { mode: "payment" }], ["unpaid", { payment_status: "unpaid" }], ["not complete", { status: "open" }],
      ["another session", { id: "cs_someone_else" }], ["no subscription id", { subscription: null }], ["unknown subscription", { client_reference_id: "nope" }], ["no reference", { client_reference_id: null }],
    ] as [string, Record<string, unknown>][]) {
      expect(await handleStripeEvent(env, sessionEvent(session(s.sub, over)), deps), label).toBe("ignored");
      expect((await getSubscription(env.DB, s.sub.id))!, label).toMatchObject({ status: "link_sent", stripeSubscriptionId: null, activatedAt: null });
    }
  });

  it("does not take a Stripe subscription that another one already holds, and a live session never activates a test subscription", async () => {
    const taken = await sub({ status: "active", stripeId: `sub_${crypto.randomUUID().slice(0, 8)}` });
    const s = await sub();
    await subscriptionCheckoutCompleted(e, session(s.sub, { subscription: taken.sub.stripeSubscriptionId }));
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("link_sent");
    const t = await sub({ test: true });
    await subscriptionCheckoutCompleted(e, session(t.sub, { livemode: true }));
    expect((await getSubscription(env.DB, t.sub.id))!.status).toBe("link_sent");
    await subscriptionCheckoutCompleted(e, session(t.sub, { livemode: false }));
    expect((await getSubscription(env.DB, t.sub.id))!.status).toBe("active");
  });

  it("an active, cancelled or ended subscription is left as it is", async () => {
    for (const status of ["active", "cancelled", "ended"] as const) {
      const s = await sub({ status });
      await subscriptionCheckoutCompleted(e, session(s.sub));
      expect((await getSubscription(env.DB, s.sub.id))!, status).toMatchObject({ status, stripeSubscriptionId: null });
    }
  });

  it("a subscription with no first charge date or term activates without a term end", async () => {
    const s = await sub({ firstChargeOn: null, termMonths: null });
    await subscriptionCheckoutCompleted(e, session(s.sub));
    expect(await getSubscription(env.DB, s.sub.id)).toMatchObject({ status: "active", termEndsOn: null });
  });
});

describe("customer.subscription.updated and deleted", () => {
  const stripeId = () => `sub_${crypto.randomUUID().slice(0, 8)}`;

  it("maps past_due to past_due, active back to active and canceled to cancelled", async () => {
    const id = stripeId();
    const s = await sub({ status: "active", stripeId: id });
    expect(await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "past_due" }), deps)).toBe("applied");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("past_due");
    expect(await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "past_due" }), deps)).toBe("applied");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("past_due");
    await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "active" }), deps);
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
    await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "canceled" }), deps);
    const gone = (await getSubscription(env.DB, s.sub.id))!;
    expect(gone.status).toBe("cancelled");
    expect(gone.cancelledAt).toMatch(/^\d{4}-/);
    // cancelled stays cancelled whatever arrives late
    await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "active" }), deps);
    await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "past_due" }), deps);
    expect((await getSubscription(env.DB, s.sub.id))!).toMatchObject({ status: "cancelled", cancelledAt: gone.cancelledAt });
  });

  it("customer.subscription.deleted cancels, once", async () => {
    const id = stripeId();
    const s = await sub({ status: "past_due", stripeId: id });
    expect(await handleStripeEvent(env, subEvent("customer.subscription.deleted", { id, status: "canceled" }), deps)).toBe("applied");
    const gone = (await getSubscription(env.DB, s.sub.id))!;
    expect(gone.status).toBe("cancelled");
    await handleStripeEvent(env, subEvent("customer.subscription.deleted", { id, status: "canceled" }), deps);
    expect((await getSubscription(env.DB, s.sub.id))!.cancelledAt).toBe(gone.cancelledAt);
  });

  it("an ended term stays ended", async () => {
    const id = stripeId();
    const s = await sub({ status: "ended", stripeId: id });
    for (const status of ["canceled", "past_due", "active"]) await subscriptionUpdated(e, { id, status });
    await handleStripeEvent(env, subEvent("customer.subscription.deleted", { id, status: "canceled" }), deps);
    expect((await getSubscription(env.DB, s.sub.id))!).toMatchObject({ status: "ended", cancelledAt: null });
  });

  it("an unknown subscription, another status or a malformed object is ignored", async () => {
    const id = stripeId();
    const s = await sub({ status: "active", stripeId: id });
    expect(await handleStripeEvent(env, subEvent("customer.subscription.updated", { id: "sub_not_ours", status: "canceled" }), deps)).toBe("ignored");
    expect(await handleStripeEvent(env, subEvent("customer.subscription.updated", { id, status: "trialing" }), deps)).toBe("ignored");
    expect(await handleStripeEvent(env, subEvent("customer.subscription.updated", {}), deps)).toBe("ignored");
    expect(await handleStripeEvent(env, subEvent("checkout.session.completed", {}), deps)).toBe("ignored");
    expect((await getSubscription(env.DB, s.sub.id))!.status).toBe("active");
  });
});

describe("a failed write is retried", () => {
  it("a failing onPaid for a milestone throws, releases the event, and the retry finishes the job without a second log", async () => {
    const m = await milestone();
    const evt = refEvent("invoice.paid", m.invoice);
    const failing = vi.fn(async () => { throw new Error("D1 is down"); });
    await expect(handleStripeEvent(env, evt, { onPaid: failing })).rejects.toThrow("D1 is down");
    expect(await handleStripeEvent(env, evt, deps)).toBe("applied");
    expect(await logs(m.businessId, "invoice_paid")).toHaveLength(1);
    expect((await getInvoice(env.DB, m.invoice.id))!.status).toBe("paid");
  });
});
