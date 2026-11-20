import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { renderReminder } from "../src/worker/billing/mail";
import { reminderStep, sweepReminders } from "../src/worker/billing/reminders";
import { planSubscriptions } from "../src/worker/billing/subscriptions";
import { createApproval } from "../src/worker/db/approvals";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact, removeDoNotContact } from "../src/worker/db/doNotContact";
import { getDocument } from "../src/worker/db/documents";
import { attachStripeInvoice, getInvoice, insertMirroredInvoice, markInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { insertOutbound, markSent } from "../src/worker/db/messages";
import { listSubscriptions } from "../src/worker/db/subscriptions";
import { saveSettings } from "../src/worker/db/settings";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { seedDraft, seedSubscriptionDoc } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";
import { KEY } from "./fixtures/stripe";

const e = env as Env;
const E_TEST = { ...env, STRIPE_SECRET_KEY: KEY } as Env;
// 10:00 on the given day in Los Angeles (winter: UTC-8).
const at = (day: string) => new Date(`${day}T18:00:00.000Z`);
const DUE = "2027-01-20";
const LINK = "https://invoice.stripe.com/i/abc";

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  await saveSettings(env.DB, { billing_config: "{}" });
  // The sweep reads every open invoice, and the tests of a file share storage: leftovers are put out of the way.
  await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** The original `invoice.send` approval of an invoice, and (when `mail` is set) the mail it sent, in the state given. */
async function sendApproval(inv: InvoiceRow, mailStatus: "sent" | "sending" | "failed" | null) {
  const a = await createApproval(env.DB, { kind: "invoice.send", title: "Send invoice", preview: "", payload: { invoiceId: inv.id }, record_type: "business", record_id: inv.businessId, drafted_by: "logan" });
  await env.DB.prepare(`UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?`).bind("2027-01-13T10:00:00.000Z", a.id).run();
  if (mailStatus) {
    const id = crypto.randomUUID();
    expect(await insertOutbound(env.DB, id, { mailbox: "main", businessId: inv.businessId, enrollmentId: null, stepIndex: null, approvalId: a.id, messageId: `<${id}@x>`, inReplyTo: null, to: "pat@ace.test", subject: "Invoice", text: "x", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
    if (mailStatus === "sent") await markSent(env.DB, id, "2027-01-13T10:00:01.000Z");
    if (mailStatus === "failed") await env.DB.prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`).bind(id).run();
  }
  return a;
}

/** A milestone invoice approved and sent the way the send approval does it: open, due `dueOn`, and its mail sent (unless `mailed` says otherwise). */
async function sent(o: { dueOn?: string | null; test?: boolean; mailed?: "sent" | "sending" | "failed" | null } = {}) {
  const s = await seedDraft({ test: o.test ?? false });
  expect(await attachStripeInvoice(env.DB, s.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: LINK, dueOn: o.dueOn === undefined ? DUE : o.dueOn, now: "2027-01-13T10:00:00.000Z" })).toBe(true);
  const inv = (await getInvoice(env.DB, s.invoice.id))!;
  await sendApproval(inv, o.mailed === undefined ? "sent" : o.mailed);
  return { ...s, invoice: inv };
}

const remindersFor = async (invoiceId: string) =>
  (await env.DB.prepare(`SELECT id, status, payload, preview, title, record_type, record_id, drafted_by FROM approvals WHERE kind = 'invoice.reminder' AND json_extract(payload, '$.invoiceId') = ? ORDER BY created_at, id`).bind(invoiceId).all<any>()).results;
const nudges = async (invoiceId: string) =>
  (await env.DB.prepare(`SELECT step, approval_id FROM invoice_nudges WHERE invoice_id = ? ORDER BY step`).bind(invoiceId).all<{ step: string; approval_id: string | null }>()).results;

/** A real subscription for a fresh client, and a mirrored monthly invoice of it (what Stripe's own cycle invoice becomes), in the state given. */
async function mirrored(o: { status: "open" | "failed"; dueOn?: string | null; failedOn?: string | null; hostedUrl?: string | null }) {
  const s = await seedSubscriptionDoc({ keys: ["website_subscription"] });
  await planSubscriptions(E_TEST, (await getDocument(env.DB, s.documentId))!);
  const sub = (await listSubscriptions(env.DB, { businessId: s.businessId }))[0];
  const { invoice } = await insertMirroredInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, subscriptionId: sub.id, kind: "subscription", ref: `stripe:in_${crypto.randomUUID().slice(0, 8)}`, test: false,
    description: "Website Subscription: monthly", lines: [{ description: "Website Subscription: monthly", amountCents: 29700 }], stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`,
    hostedUrl: o.hostedUrl === undefined ? "https://invoice.stripe.com/i/sub" : o.hostedUrl, dueOn: o.dueOn ?? null, failedOn: null, now: "2027-01-05T10:00:00.000Z",
  });
  if (o.status === "failed") expect(await markInvoice(env.DB, invoice.id, { status: "failed", failedOn: o.failedOn ?? null }, { failedOnOnce: true })).toBe(true);
  return { ...s, invoice: (await getInvoice(env.DB, invoice.id))! };
}

describe("reminderStep", () => {
  it("-4 days is null, -3 is 1, 0 is 2, 5 is 3, 9 is 4", () => {
    const offsets = [-3, 0, 3, 7];
    expect(reminderStep(offsets, -4)).toBeNull();
    expect(reminderStep(offsets, -3)).toBe(1);
    expect(reminderStep(offsets, -1)).toBe(1);
    expect(reminderStep(offsets, 0)).toBe(2);
    expect(reminderStep(offsets, 2)).toBe(2);
    expect(reminderStep(offsets, 5)).toBe(3);
    expect(reminderStep(offsets, 7)).toBe(4);
    expect(reminderStep(offsets, 9)).toBe(4);
    expect(reminderStep(offsets, 400)).toBe(4);
  });
});

describe("the kind", () => {
  it("is registered and takes an invoice id and a step", () => {
    const h = getHandler("invoice.reminder")!;
    expect(h.label).toBe("Send reminder");
    expect(h.parse({ invoiceId: "x", step: 2 })).toEqual({ invoiceId: "x", step: 2 });
    expect(() => h.parse({ invoiceId: "x" })).toThrow();
    expect(() => h.parse({ invoiceId: "x", step: 0 })).toThrow();
    expect(() => h.parse({ invoiceId: "x", step: 1.5 })).toThrow();
    expect(() => h.parse({ step: 1 })).toThrow();
  });
});

describe("the sweep", () => {
  it("an invoice three days before its due date drafts step 1 once across two sweeps", async () => {
    const s = await sent();
    expect(await sweepReminders(e, at("2027-01-16"))).toBe(0); // four days out: not yet
    expect(await nudges(s.invoice.id)).toHaveLength(0);

    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(0);
    expect(await sweepReminders(e, at("2027-01-18"))).toBe(0); // still step 1
    const [a, ...rest] = await remindersFor(s.invoice.id);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({ status: "pending", record_type: "business", record_id: s.businessId, drafted_by: "logan" });
    expect(JSON.parse(a.payload)).toEqual({ invoiceId: s.invoice.id, step: 1 });
    expect(await nudges(s.invoice.id)).toEqual([{ step: "r1", approval_id: a.id }]);
    expect(a.title).toContain("Ace Plumbing");
    expect(a.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a.preview).toContain("Hi Pat,");
    expect(a.preview).toContain(LINK);
    expect(a.preview).toContain("Nothing is mailed until you approve");
  });

  it("two sweeps at the same moment draft one", async () => {
    const s = await sent();
    const [x, y] = await Promise.all([sweepReminders(e, at("2027-01-17")), sweepReminders(e, at("2027-01-17"))]);
    expect(x + y).toBe(1);
    expect(await remindersFor(s.invoice.id)).toHaveLength(1);
  });

  it("a sweep after a skipped week drafts only the highest step reached", async () => {
    const fresh = await sent();
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(1); // seven days late: step 4, never 1 to 3
    expect(await nudges(fresh.invoice.id)).toEqual([{ step: "r4", approval_id: expect.any(String) }]);
    expect(JSON.parse((await remindersFor(fresh.invoice.id))[0].payload).step).toBe(4);
  });

  it("the next day's sweep drafts the next step and not the earlier ones", async () => {
    const s = await sent();
    expect(await sweepReminders(e, at("2027-01-20"))).toBe(1); // the due date: step 2, no step 1
    expect((await nudges(s.invoice.id)).map((n) => n.step)).toEqual(["r2"]);
    expect(await sweepReminders(e, at("2027-01-21"))).toBe(0);
    expect(await sweepReminders(e, at("2027-01-23"))).toBe(1); // three days late: step 3
    expect((await nudges(s.invoice.id)).map((n) => n.step)).toEqual(["r2", "r3"]);
    expect((await remindersFor(s.invoice.id)).map((a) => JSON.parse(a.payload).step)).toEqual([2, 3]);
  });

  it("a draft, paid, void, uncollectible or test invoice is never reminded", async () => {
    const draft = await seedDraft();
    const paid = await sent(); const voided = await sent(); const lost = await sent(); const test = await sent({ test: true });
    await markInvoice(env.DB, paid.invoice.id, { status: "paid", paidAt: "2027-01-15T10:00:00.000Z" });
    await markInvoice(env.DB, voided.invoice.id, { status: "void" });
    await markInvoice(env.DB, lost.invoice.id, { status: "uncollectible" });
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(0);
    for (const x of [draft, paid, voided, lost, test]) {
      expect(await remindersFor(x.invoice.id)).toHaveLength(0);
      expect(await nudges(x.invoice.id)).toHaveLength(0);
    }
  });

  it("an open invoice with no due date is not reminded", async () => {
    const s = await sent({ dueOn: null });
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(0);
    expect(await nudges(s.invoice.id)).toHaveLength(0);
  });

  it("an open invoice whose original mail never went is skipped, and reminded once it did", async () => {
    // Approved, the invoice made at Stripe (so it reads open and sent), but the mail failed and the approval was dropped: the client never got the link.
    const none = await sent({ mailed: null });
    const failed = await sent({ mailed: "failed" });
    const stuck = await sent({ mailed: "sending" });
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(0);
    for (const x of [none, failed, stuck]) {
      expect(await remindersFor(x.invoice.id)).toHaveLength(0);
      expect(await nudges(x.invoice.id)).toHaveLength(0); // not claimed either, so the first mail going out later is enough
    }
    await env.DB.prepare(`UPDATE messages SET status = 'sent', sent_at = '2027-01-26T10:00:00.000Z' WHERE approval_id IN (SELECT id FROM approvals WHERE kind = 'invoice.send' AND json_extract(payload, '$.invoiceId') = ?)`).bind(failed.invoice.id).run();
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(1);
    expect(await remindersFor(failed.invoice.id)).toHaveLength(1);
  });

  it("a mirrored subscription invoice in failed is reminded from failed_on, with no invoice.send mail behind it", async () => {
    const s = await mirrored({ status: "failed", failedOn: "2027-01-10" });
    expect(s.invoice).toMatchObject({ status: "failed", failedOn: "2027-01-10", dueOn: null });
    expect(await sweepReminders(e, at("2027-01-10"))).toBe(1); // the day it failed: step 2 (the due-date step)
    expect(await sweepReminders(e, at("2027-01-10"))).toBe(0);
    expect((await nudges(s.invoice.id)).map((n) => n.step)).toEqual(["r2"]);
    const [a] = await remindersFor(s.invoice.id);
    expect(JSON.parse(a.payload)).toEqual({ invoiceId: s.invoice.id, step: 2 });
    expect(a.preview).toContain("https://invoice.stripe.com/i/sub");
    expect(a.preview).toContain("payment method");
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1); // a week on: step 4, the last
    expect((await nudges(s.invoice.id)).map((n) => n.step)).toEqual(["r2", "r4"]);
    expect((await remindersFor(s.invoice.id))[1].preview).toContain("January 24, 2027"); // failed_on plus the 14 days
  });

  it("a mirrored subscription invoice still open is reminded from its due date, and one with no date or no link is not", async () => {
    const dated = await mirrored({ status: "open", dueOn: "2027-01-20" });
    const undated = await mirrored({ status: "open" });
    const linkless = await mirrored({ status: "failed", failedOn: "2027-01-10", hostedUrl: null });
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);
    expect(await remindersFor(dated.invoice.id)).toHaveLength(1);
    expect(await remindersFor(undated.invoice.id)).toHaveLength(0);
    expect(await remindersFor(linkless.invoice.id)).toHaveLength(0);
  });

  it("changing the offsets in settings changes the steps for later sweeps", async () => {
    await saveSettings(env.DB, { billing_config: JSON.stringify({ reminderOffsets: [-1, 5] }) });
    const s = await sent();
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(0); // three days out: the first reminder is now one day out
    expect(await sweepReminders(e, at("2027-01-19"))).toBe(1);
    expect(await sweepReminders(e, at("2027-01-23"))).toBe(0);
    expect(await sweepReminders(e, at("2027-01-25"))).toBe(1);
    expect((await nudges(s.invoice.id)).map((n) => n.step)).toEqual(["r1", "r2"]);
    expect((await remindersFor(s.invoice.id))[1].preview).toContain("February 3, 2027"); // the last step of two names the pause
  });

  it("never drafts a lower step after a higher one when the offsets are changed", async () => {
    const s = await sent();
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(1); // r4
    await saveSettings(env.DB, { billing_config: JSON.stringify({ reminderOffsets: [0, 30] }) });
    expect(await sweepReminders(e, at("2027-01-28"))).toBe(0); // step 1 now, below the r4 already raised
    expect(await remindersFor(s.invoice.id)).toHaveLength(1);
  });

  it("an invoice with no https link is skipped and does not stop the others", async () => {
    const bad = await sent();
    const good = await sent();
    await env.DB.prepare(`UPDATE invoices SET hosted_url = 'http://insecure.test/x' WHERE id = ?`).bind(bad.invoice.id).run();
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);
    expect(await remindersFor(good.invoice.id)).toHaveLength(1);
    expect(await remindersFor(bad.invoice.id)).toHaveLength(0);
    expect(await nudges(bad.invoice.id)).toHaveLength(0);
  });
});

describe("approving a reminder", () => {
  async function drafted(day: string, o: Parameters<typeof sent>[0] = {}) {
    const s = await sent(o);
    expect(await sweepReminders(e, at(day))).toBe(1);
    const [a] = await remindersFor(s.invoice.id);
    return { ...s, approvalId: a.id as string };
  }

  it("mails the fixed reminder once, with the hosted link", async () => {
    const s = await drafted("2027-01-17");
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test" });
    expect(mail.sent[0].subject).toContain("January 20, 2027");
    expect(mail.sent[0].text).toContain("Hi Pat,");
    expect(mail.sent[0].text).toContain(LINK);
    expect(mail.sent[0].text).toContain("$1,000");
    expect((await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("reminder 1 sent"))).toHaveLength(1);
    // Put back to pending after it was mailed (something later failed): nothing more goes out.
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(s.approvalId).run();
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("reminder 1 sent"))).toHaveLength(1);
  });

  it("approving a reminder for an invoice paid meanwhile mails nothing and says so", async () => {
    const s = await drafted("2027-01-20");
    await markInvoice(env.DB, s.invoice.id, { status: "paid", paidAt: "2027-01-20T20:00:00.000Z" });
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    const lines = (await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("reminder 2 not sent"));
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("paid");
    expect(lines[0].detail).toContain("Milestone");
  });

  it("an invoice voided or written off meanwhile mails nothing either", async () => {
    for (const status of ["void", "uncollectible"] as const) {
      const s = await drafted("2027-01-20");
      await markInvoice(env.DB, s.invoice.id, { status });
      expect(await approve(e, s.approvalId)).toEqual({ ok: true });
      expect(mail.sent).toHaveLength(0);
    }
  });

  it("an invoice that went from open to failed meanwhile is still reminded", async () => {
    const s = await drafted("2027-01-20");
    await markInvoice(env.DB, s.invoice.id, { status: "failed", failedOn: "2027-01-19" }, { failedOnOnce: true });
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a client on the do-not-contact list is not mailed, and the approval goes back to pending with the reason", async () => {
    const s = await drafted("2027-01-17");
    const listed = await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const r = await approve(e, s.approvalId);
    await removeDoNotContact(env.DB, listed.id);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/Blocked: .*do-not-contact/);
    expect(mail.sent).toHaveLength(0);
  });

  it("a main mailbox that cannot send puts the approval back to pending", async () => {
    const s = await drafted("2027-01-17");
    await readyToSend({ mailbox: false });
    const r = await approve(e, s.approvalId);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("main mailbox");
    expect(mail.sent).toHaveLength(0);
  });

  it("a test invoice goes to the owner only, with [Test] on the subject", async () => {
    const s = await sent({ test: true });
    const a = await createApproval(env.DB, { kind: "invoice.reminder", title: "Send reminder", preview: "", payload: { invoiceId: s.invoice.id, step: 1 }, record_type: "business", record_id: s.businessId, drafted_by: "logan" });
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("logan@siteline.test");
    expect(mail.sent[0].subject.startsWith("[Test] ")).toBe(true);
  });

  it("the last step's mail names the pause date, due plus pauseAfterDays", async () => {
    const s = await drafted("2027-01-27");
    expect(JSON.parse((await remindersFor(s.invoice.id))[0].payload).step).toBe(4);
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain("February 3, 2027"); // 2027-01-20 + 14
    expect(mail.sent[0].text.toLowerCase()).toContain("pause");
    expect(mail.sent[0].text.toLowerCase()).toContain("overdue");
  });
});

describe("the pause sentence", () => {
  const NOW = "Work on your project cannot continue until this invoice is paid.";
  /** The mail clock (what a reminder's preview and send read as today), with the same recording sender. */
  const clock = (day: string) => setMailDeps({ smtp: async (_mb, _pw, msg) => { mail.sent.push(msg); }, now: () => at(day) });
  async function lastStep() {
    const s = await sent();
    expect(await sweepReminders(e, at("2027-01-27"))).toBe(1); // step 4, the last; its pause date is 2027-02-03
    const [a] = await remindersFor(s.invoice.id);
    expect(JSON.parse(a.payload).step).toBe(4);
    return { ...s, approvalId: a.id as string, preview: a.preview as string };
  }

  it("approving the last step after the pause date says work cannot continue, with no past date", async () => {
    const s = await lastStep();
    clock("2027-02-05");
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain(NOW);
    expect(mail.sent[0].text).not.toContain("February 3");
    expect(mail.sent[0].text).not.toContain("pauses on");
  });

  it("on the pause date itself it is already present tense", async () => {
    const s = await lastStep();
    clock("2027-02-03");
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain(NOW);
    expect(mail.sent[0].text).not.toContain("February 3");
  });

  it("approving the last step before the pause date still names it", async () => {
    const s = await lastStep();
    clock("2027-02-02");
    expect(await approve(e, s.approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain("pauses on that date");
    expect(mail.sent[0].text).toContain("February 3, 2027");
    expect(mail.sent[0].text).not.toContain(NOW);
  });

  it("the draft preview and the sent mail say the same on the same day, before and after the pause date", async () => {
    for (const day of ["2027-02-02", "2027-02-05"]) {
      mail.sent.length = 0;
      const s = await sent();
      clock(day);
      expect(await sweepReminders(e, at(day))).toBe(1);
      const [a] = await remindersFor(s.invoice.id);
      expect(JSON.parse(a.payload).step).toBe(4);
      expect(await approve(e, a.id)).toEqual({ ok: true });
      const m = mail.sent[0];
      expect(a.preview).toContain(m.text.split("\n\nThanks,")[0]); // everything up to the sign-off (the sender adds the saved signature after it)
      expect(a.preview).toContain(`Subject: ${m.subject}`);
      expect(m.text.includes(NOW)).toBe(day === "2027-02-05");
    }
  });

  it("a one-offset ladder of a heads-up never says the project pauses", async () => {
    await saveSettings(env.DB, { billing_config: JSON.stringify({ reminderOffsets: [-3] }) });
    const s = await sent();
    clock("2027-01-17");
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);
    const [a] = await remindersFor(s.invoice.id);
    expect(a.preview).not.toMatch(/pause|cannot continue/);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain("coming up");
    expect(mail.sent[0].text).not.toMatch(/pause|cannot continue/);
  });

  it("renderReminder: today decides the tense, and a heads-up or due-date step has no pause sentence at all", () => {
    const i = { id: "i", businessId: "b", dealId: null, documentId: null, projectId: null, changeOrderId: null, subscriptionId: null, kind: "milestone", ref: "r", test: false, description: "Design", lines: [], stripeCustomerId: null, stripeInvoiceId: null, amountCents: 5000, status: "open", hostedUrl: LINK, dueOn: DUE, sentAt: null, failedOn: null, mismatch: null, createdAt: "", paidAt: null } as InvoiceRow;
    const c = { contactName: "Pat", yourName: "Logan", pauseOn: "2027-02-03", offset: 7 };
    expect(renderReminder(4, 4, i, LINK, { ...c, today: "2027-02-02" }).body).toContain("pauses on that date");
    expect(renderReminder(4, 4, i, LINK, { ...c, today: "2027-02-03" }).body).toContain(NOW);
    expect(renderReminder(4, 4, i, LINK, c).body).toContain("pauses on that date"); // no clock given: the future tense, as before
    for (const offset of [-3, 0]) expect(renderReminder(1, 1, i, LINK, { ...c, offset, today: "2027-03-01" }).body).not.toMatch(/pause|cannot continue/);
  });
});

describe("renderReminder", () => {
  const inv = (o: Partial<InvoiceRow> = {}): InvoiceRow => ({
    id: "i", businessId: "b", dealId: null, documentId: null, projectId: null, changeOrderId: null, subscriptionId: null, kind: "milestone", ref: "r", test: false,
    description: "Design approved", lines: [{ description: "Design approved", amountCents: 123450 }], stripeCustomerId: null, stripeInvoiceId: null, amountCents: 123450,
    status: "open", hostedUrl: LINK, dueOn: DUE, sentAt: null, failedOn: null, mismatch: null, createdAt: "", paidAt: null, ...o,
  });
  const c = { contactName: "Pat Jones", yourName: "Logan", pauseOn: "2027-02-03" };

  it("before the due date is a heads-up, on it a plain reminder, later steps say overdue, the last names the pause", () => {
    const m1 = renderReminder(1, 4, inv(), LINK, { ...c, offset: -3 });
    expect(m1.subject).toContain("January 20, 2027");
    expect(m1.body).toContain("coming up");
    expect(m1.body).not.toContain("overdue");
    expect(m1.body).not.toContain("pause");
    expect(m1.body).toContain("$1,234.50");
    expect(m1.body).toContain(LINK);
    const m2 = renderReminder(2, 4, inv(), LINK, { ...c, offset: 0 });
    expect(m2.body).toContain("due today");
    const m3 = renderReminder(3, 4, inv(), LINK, { ...c, offset: 3 });
    expect(m3.body).toContain("overdue");
    expect(m3.body).not.toContain("pause");
    const m4 = renderReminder(4, 4, inv(), LINK, { ...c, offset: 7 });
    expect(m4.body).toContain("overdue");
    expect(m4.body).toContain("February 3, 2027");
    expect(m4.body).toContain("pause");
    // Without the offset the default ladder's order is used.
    expect(renderReminder(1, 4, inv(), LINK, c).body).toContain("coming up");
    expect(renderReminder(2, 4, inv(), LINK, c).body).toContain("due today");
    expect(renderReminder(3, 4, inv(), LINK, c).body).toContain("overdue");
  });

  it("a failed autopay invoice links the page to update the payment method", () => {
    const m = renderReminder(2, 4, inv({ kind: "subscription", status: "failed", dueOn: null, failedOn: "2027-01-10", description: "Website Subscription: monthly" }), "https://invoice.stripe.com/i/sub", { ...c, offset: 0 });
    expect(m.body).toContain("did not go through");
    expect(m.body).toContain("payment method");
    expect(m.body).toContain("https://invoice.stripe.com/i/sub");
    expect(m.body).not.toContain("coming up");
  });

  it("puts what a person typed on one line and caps it", () => {
    const m = renderReminder(3, 4, inv({ description: "Design\nBcc: evil@x.test ".repeat(40) }), LINK, { contactName: "Pat\nJones\r\nBcc: x", yourName: "Lo\ngan", pauseOn: DUE, offset: 3 });
    expect(m.subject.length).toBeLessThanOrEqual(200);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.body.split("\n\n")[0]).toBe("Hi Pat,");
    expect(m.body).not.toMatch(/Design\nBcc/);
    expect(m.body).toContain("Lo gan");
  });
});
