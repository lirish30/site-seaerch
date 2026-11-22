import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/worker/approvals/onboardingNudge";
import { sweepReminders } from "../src/worker/billing/reminders";
import { listActivity } from "../src/worker/db/activity";
import { createApproval } from "../src/worker/db/approvals";
import { listAutoApprovals, setRule } from "../src/worker/db/autoApprove";
import { createDraft } from "../src/worker/db/documents";
import { attachStripeInvoice, getInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { createOnboarding, markWelcomeSent, type NewItem } from "../src/worker/db/onboardings";
import { insertOutbound, markSent } from "../src/worker/db/messages";
import { saveSettings } from "../src/worker/db/settings";
import type { Env } from "../src/worker/env";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { dueDatesFor } from "../src/worker/onboarding/schedule";
import { sweepOnboardings } from "../src/worker/onboarding/sweep";
import { seedDraft } from "./fixtures/billing";
import { proposal, readyToSend, seedDeal } from "./fixtures/documents";

// The two real sweeps with the switches on and off, the mail transport replaced by a fake. Nothing here presses Approve.
const e = env as Env;
const at = (day: string) => new Date(`${day}T18:00:00.000Z`);
const LINK = "https://invoice.stripe.com/i/abc";
const DAY = 86_400_000;
const T0 = new Date("2026-11-02T17:00:00.000Z"); // a Monday, 09:00 in Los Angeles
const ITEMS: NewItem[] = [{ key: "logo", label: "Logo", instructions: "Send your logo", kind: "files", phase: 1 }];

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  await saveSettings(env.DB, { billing_config: "{}" });
  await env.DB.batch(["auto_approvals", "auto_approve_rules", "onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM approvals WHERE kind IN ('invoice.reminder', 'onboarding.nudge')`).run();
  await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const on = (kind: string) => setRule(env.DB, kind, true, new Date(Date.now() - 60_000).toISOString());
const activity = async (businessId: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === "auto_approved").map((a) => a.detail ?? "");
const approvalsOf = async (kind: string) => (await env.DB.prepare(`SELECT id, status, error FROM approvals WHERE kind = ? ORDER BY created_at, id`).bind(kind).all<{ id: string; status: string; error: string | null }>()).results;

/** An open real invoice due 2027-01-20 whose own `invoice.send` mail was sent (the sweep reminds only an invoice the client really received). */
async function sentInvoice() {
  const s = await seedDraft();
  expect(await attachStripeInvoice(env.DB, s.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: LINK, dueOn: "2027-01-20", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
  const inv = (await getInvoice(env.DB, s.invoice.id))! as InvoiceRow;
  const a = await createApproval(env.DB, { kind: "invoice.send", title: "Send invoice", preview: "", payload: { invoiceId: inv.id }, record_type: "business", record_id: inv.businessId, drafted_by: "logan" });
  await env.DB.prepare(`UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?`).bind("2027-01-13T10:00:00.000Z", a.id).run();
  const id = crypto.randomUUID();
  expect(await insertOutbound(env.DB, id, { mailbox: "main", businessId: inv.businessId, enrollmentId: null, stepIndex: null, approvalId: a.id, messageId: `<${id}@x>`, inReplyTo: null, to: "pat@ace.test", subject: "Invoice", text: "x", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
  await markSent(env.DB, id, "2027-01-13T10:00:01.000Z");
  return { ...s, invoice: inv };
}

/** A welcomed onboarding (the welcome went out at T0) whose client has been silent. */
async function onboarding() {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { onboarding: o } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "build", test: false, items: ITEMS });
  await markWelcomeSent(env.DB, o.id, { sentAt: T0.toISOString(), ...dueDatesFor(T0) });
  return { ...s, id: o.id };
}
/** The mail transport's clock is the sweep's, as it is in production. */
const clockAt = (d: Date) => setMailDeps({ ...getMailDeps(), now: () => d });

describe("auto-approve through the real sweeps", () => {
  it("the real billing reminder sweep with the rule on drafts and sends step 1 through the transport fake without a person", async () => {
    await on("invoice.reminder");
    const s = await sentInvoice();
    clockAt(at("2027-01-17"));
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);

    const [a, ...rest] = await approvalsOf("invoice.reminder");
    expect(rest).toHaveLength(0);
    expect(a.status).toBe("approved");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(await listAutoApprovals(env.DB, 10)).toMatchObject([{ approvalId: a.id, kind: "invoice.reminder", businessId: s.businessId, outcome: "sent", error: null }]);
    expect(await activity(s.businessId)).toEqual([expect.stringContaining("reminder 1")]);
    // The claim is kept and linked, as for any reminder.
    expect((await env.DB.prepare(`SELECT approval_id FROM invoice_nudges WHERE invoice_id = ? AND step = 'r1'`).bind(s.invoice.id).first<{ approval_id: string }>())!.approval_id).toBe(a.id);
    // A second sweep the same day sends nothing more.
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it("the same sweep with the rule off leaves it pending", async () => {
    const s = await sentInvoice();
    clockAt(at("2027-01-17"));
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(1);
    expect((await approvalsOf("invoice.reminder")).map((a) => a.status)).toEqual(["pending"]);
    expect(mail.sent).toHaveLength(0);
    expect(await listAutoApprovals(env.DB, 10)).toEqual([]);
    expect(await activity(s.businessId)).toEqual([]);
  });

  it("a send that fails in the billing sweep leaves that reminder pending and does not stop the next invoice", async () => {
    await on("invoice.reminder");
    const first = await sentInvoice();
    const second = await sentInvoice();
    clockAt(at("2027-01-17"));
    mail.failures.push(new Error("smtp is down"));
    expect(await sweepReminders(e, at("2027-01-17"))).toBe(2); // both were drafted
    const rows = await approvalsOf("invoice.reminder");
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "pending"]);
    expect(rows.find((r) => r.status === "pending")!.error).toContain("smtp is down");
    expect((await listAutoApprovals(env.DB, 10)).map((r) => r.outcome).sort()).toEqual(["failed", "sent"]);
    expect(mail.sent).toHaveLength(1);
    expect([first, second].length).toBe(2);
  });

  it("the real onboarding sweep likewise: level 1 goes through the transport fake with the rule on", async () => {
    await on("onboarding.nudge");
    const s = await onboarding();
    const now = new Date(T0.getTime() + 2 * DAY);
    clockAt(now);
    expect(await sweepOnboardings(e, now)).toEqual({ reminders: 1, fridays: 0, waiting: 0 });

    const [a, ...rest] = await approvalsOf("onboarding.nudge");
    expect(rest).toHaveLength(0);
    expect(a.status).toBe("approved");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(await listAutoApprovals(env.DB, 10)).toMatchObject([{ approvalId: a.id, kind: "onboarding.nudge", businessId: s.businessId, outcome: "sent" }]);
    expect(await activity(s.businessId)).toHaveLength(1);
    expect(await sweepOnboardings(e, new Date(now.getTime() + 3_600_000))).toEqual({ reminders: 0, fridays: 0, waiting: 0 });
    expect(mail.sent).toHaveLength(1);
  });

  it("the onboarding sweep with the rule off leaves the reminder pending", async () => {
    const s = await onboarding();
    const now = new Date(T0.getTime() + 2 * DAY);
    clockAt(now);
    expect(await sweepOnboardings(e, now)).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    expect((await approvalsOf("onboarding.nudge")).map((a) => a.status)).toEqual(["pending"]);
    expect(mail.sent).toHaveLength(0);
    expect(await activity(s.businessId)).toEqual([]);
  });

  it("a failed auto-send in the onboarding sweep never releases the nudge claim, so the next sweep does not draft it again", async () => {
    await on("onboarding.nudge");
    const s = await onboarding();
    const now = new Date(T0.getTime() + 2 * DAY);
    clockAt(now);
    mail.failures.push(new Error("smtp is down"));
    expect(await sweepOnboardings(e, now)).toEqual({ reminders: 1, fridays: 0, waiting: 0 });
    const [a] = await approvalsOf("onboarding.nudge");
    expect(a.status).toBe("pending");
    expect(a.error).toContain("smtp is down");
    expect((await env.DB.prepare(`SELECT approval_id FROM onboarding_nudges WHERE onboarding_id = ?`).bind(s.id).all<{ approval_id: string }>()).results.map((r) => r.approval_id)).toEqual([a.id]);
    expect(await sweepOnboardings(e, new Date(now.getTime() + 3_600_000))).toEqual({ reminders: 0, fridays: 0, waiting: 0 });
    expect(await approvalsOf("onboarding.nudge")).toHaveLength(1);
    expect(await listAutoApprovals(env.DB, 10)).toMatchObject([{ outcome: "failed", error: expect.stringContaining("smtp is down") }]);
  });
});
