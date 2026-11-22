import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_APPROVE_KINDS, AUTO_DAILY_CAP, autoEligible, maybeAutoApprove } from "../src/worker/approvals/auto";
import "../src/worker/approvals/ladderMail";
import { createApproval, toApproval, type Approval } from "../src/worker/db/approvals";
import { listActivity } from "../src/worker/db/activity";
import { countAutoApprovalsOn, listAutoApprovals, recordAutoApproval, setRule } from "../src/worker/db/autoApprove";
import { createDraft } from "../src/worker/db/documents";
import { placeHold } from "../src/worker/db/holds";
import { attachStripeInvoice, getInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { createOnboarding, getOnboarding, markWelcomeSent, type NewItem } from "../src/worker/db/onboardings";
import { saveSettings } from "../src/worker/db/settings";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { dueDatesFor } from "../src/worker/onboarding/schedule";
import { seedDraft } from "./fixtures/billing";
import { proposal, readyToSend, seedDeal } from "./fixtures/documents";

const e = env as Env;
/** 10:00 on a winter day in Los Angeles. */
const NOW = new Date("2027-01-17T18:00:00.000Z");
const LINK = "https://invoice.stripe.com/i/abc";
const ITEMS: NewItem[] = [{ key: "logo", label: "Logo", instructions: "Send your logo", kind: "files", phase: 1 }];

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  await saveSettings(env.DB, { billing_config: "{}" });
  await env.DB.batch(["auto_approvals", "auto_approve_rules"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** A rule switched on a minute before every approval this test makes (an approval made now is after the switch). */
const on = (kind: string) => setRule(env.DB, kind, true, new Date(Date.now() - 60_000).toISOString());
const approvalRow = async (id: string) => toApproval((await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<Parameters<typeof toApproval>[0]>())!);
const statusOf = async (id: string) => (await approvalRow(id)).status;
const activity = async (businessId: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === "auto_approved").map((a) => a.detail ?? "");

/** An open real invoice whose original mail went, and a reminder approval of `step` for it. */
async function reminder(o: { step?: number; test?: boolean } = {}) {
  const s = await seedDraft({ test: o.test ?? false });
  expect(await attachStripeInvoice(env.DB, s.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: LINK, dueOn: "2027-01-20", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
  const invoice = (await getInvoice(env.DB, s.invoice.id))! as InvoiceRow;
  const approval = await createApproval(env.DB, {
    kind: "invoice.reminder", title: `Send reminder ${o.step ?? 1} for Milestone to Ace Plumbing`, preview: "x", payload: { invoiceId: invoice.id, step: o.step ?? 1 },
    record_type: "business", record_id: invoice.businessId, drafted_by: "logan",
  });
  return { ...s, invoice, approval };
}

/** A welcomed onboarding and a nudge approval for `key` (`@` in it stands for the client's last activity, which a reminder key carries). */
async function nudge(key: string, o: { test?: boolean } = {}) {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { onboarding } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "build", test: o.test ?? false, items: ITEMS });
  await markWelcomeSent(env.DB, onboarding.id, { sentAt: "2027-01-05T17:00:00.000Z", ...dueDatesFor(new Date("2027-01-05T17:00:00.000Z")) });
  const since = (await getOnboarding(env.DB, onboarding.id))!.lastClientActivityAt ?? "none";
  const approval = await createApproval(env.DB, {
    kind: "onboarding.nudge", title: "Send reminder", preview: "x", payload: { onboardingId: onboarding.id, nudgeKey: key.replace("@", since) }, record_type: "deal", record_id: s.dealId, drafted_by: "job",
  });
  return { ...s, onboardingId: onboarding.id, approval };
}

describe("auto-approve", () => {
  it("both rules start off and nothing is auto-approved while off", async () => {
    expect(AUTO_APPROVE_KINDS).toEqual(["invoice.reminder", "onboarding.nudge"]);
    const r = await reminder();
    const n = await nudge("reminder:1:@");
    expect(await autoEligible(e, r.approval)).toEqual({ ok: false, why: expect.stringContaining("off") });
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    expect(await maybeAutoApprove(e, n.approval, NOW)).toBe("left");
    expect(await statusOf(r.approval.id)).toBe("pending");
    expect(await statusOf(n.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(0);
    expect(await countAutoApprovalsOn(env.DB, "2027-01-17")).toBe(0);
  });

  it("an approval created before the rule was switched on stays pending", async () => {
    const r = await reminder();
    await setRule(env.DB, "invoice.reminder", true, new Date(Date.now() + 60_000).toISOString()); // switched on after the approval was made
    expect(await autoEligible(e, r.approval)).toEqual({ ok: false, why: expect.stringContaining("before") });
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    expect(await statusOf(r.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(0);
    // At the very moment of the switch counts as after it.
    await setRule(env.DB, "invoice.reminder", false, new Date().toISOString());
    await setRule(env.DB, "invoice.reminder", true, r.approval.created_at);
    expect(await autoEligible(e, r.approval)).toEqual({ ok: true });
  });

  it("with the rule on, invoice reminder steps 1 to 3 of 4 are approved and step 4 is left", async () => {
    await on("invoice.reminder");
    for (const step of [1, 2, 3]) {
      const r = await reminder({ step });
      expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("approved");
      expect(await statusOf(r.approval.id)).toBe("approved");
      expect(await activity(r.businessId)).toEqual([expect.stringContaining(`reminder ${step}`)]);
    }
    expect(mail.sent).toHaveLength(3);
    const last = await reminder({ step: 4 });
    expect(await autoEligible(e, last.approval)).toEqual({ ok: false, why: expect.stringContaining("last") });
    expect(await maybeAutoApprove(e, last.approval, NOW)).toBe("left");
    expect(await statusOf(last.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(3);
    expect((await listAutoApprovals(env.DB, 10)).map((a) => [a.outcome, a.error])).toEqual([["sent", null], ["sent", null], ["sent", null]]);
    expect(await countAutoApprovalsOn(env.DB, "2027-01-17")).toBe(3);
  });

  it("the last step is the one the billing settings name, not a fixed 4", async () => {
    await on("invoice.reminder");
    await saveSettings(env.DB, { billing_config: JSON.stringify({ reminderOffsets: [-3, 0] }) });
    const one = await reminder({ step: 1 });
    const two = await reminder({ step: 2 });
    expect(await maybeAutoApprove(e, one.approval, NOW)).toBe("approved");
    expect(await maybeAutoApprove(e, two.approval, NOW)).toBe("left");
  });

  it("a test invoice and a held client are left", async () => {
    await on("invoice.reminder");
    const test = await reminder({ test: true });
    expect(await autoEligible(e, test.approval)).toEqual({ ok: false, why: expect.stringContaining("test") });
    expect(await maybeAutoApprove(e, test.approval, NOW)).toBe("left");
    const held = await reminder();
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice.id, now: "2027-01-16T10:00:00.000Z" })).toBe(true);
    expect(await autoEligible(e, held.approval)).toEqual({ ok: false, why: expect.stringContaining("hold") });
    expect(await maybeAutoApprove(e, held.approval, NOW)).toBe("left");
    expect(await statusOf(test.approval.id)).toBe("pending");
    expect(await statusOf(held.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(0);
  });

  it("a client that is only a test client (a test site, nothing real) is left", async () => {
    await on("invoice.reminder");
    const r = await reminder();
    await env.DB.prepare(`INSERT INTO sites (id, business_id, url, test, created_at, updated_at) VALUES (?, ?, 'https://t.test', 1, ?, ?)`)
      .bind(crypto.randomUUID(), r.businessId, "2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").run();
    expect(await autoEligible(e, r.approval)).toEqual({ ok: false, why: expect.stringContaining("test") });
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
  });

  it("onboarding levels 1 to 3 are approved, level 4 and the Friday update are left", async () => {
    await on("onboarding.nudge");
    for (const level of [1, 2, 3]) {
      const n = await nudge(`reminder:${level}:@`);
      expect(await maybeAutoApprove(e, n.approval, NOW)).toBe("approved");
      expect(await statusOf(n.approval.id)).toBe("approved");
      expect(await activity(n.businessId)).toHaveLength(1);
    }
    expect(mail.sent).toHaveLength(3);
    const four = await nudge("reminder:4:@");
    const friday = await nudge("friday:2027-01-15");
    for (const n of [four, friday]) {
      expect(await autoEligible(e, n.approval)).toEqual({ ok: false, why: expect.any(String) });
      expect(await maybeAutoApprove(e, n.approval, NOW)).toBe("left");
      expect(await statusOf(n.approval.id)).toBe("pending");
    }
    expect(mail.sent).toHaveLength(3);
  });

  it("a test onboarding and a held client are left", async () => {
    await on("onboarding.nudge");
    const test = await nudge("reminder:1:@", { test: true });
    expect(await autoEligible(e, test.approval)).toEqual({ ok: false, why: expect.stringContaining("test") });
    expect(await maybeAutoApprove(e, test.approval, NOW)).toBe("left");
    const held = await nudge("reminder:1:@");
    const owed = await seedDraft({ seed: { ...held, documentId: (await env.DB.prepare(`SELECT document_id AS d FROM onboardings WHERE id = ?`).bind(held.onboardingId).first<{ d: string }>())!.d } });
    await attachStripeInvoice(env.DB, owed.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: "in_held1", hostedUrl: LINK, dueOn: "2027-01-10", now: "2027-01-03T10:00:00.000Z" });
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: owed.invoice.id, now: "2027-01-16T10:00:00.000Z" })).toBe(true);
    expect(await autoEligible(e, held.approval)).toEqual({ ok: false, why: expect.stringContaining("hold") });
    expect(await maybeAutoApprove(e, held.approval, NOW)).toBe("left");
    expect(await statusOf(test.approval.id)).toBe("pending");
    expect(await statusOf(held.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(0);
  });

  it("the 21st auto-approval of a local day is left pending", async () => {
    await on("invoice.reminder");
    expect(AUTO_DAILY_CAP).toBe(20);
    // 20 already today (the local day of NOW is 2027-01-17); one from yesterday does not count.
    for (let i = 0; i < AUTO_DAILY_CAP; i++) await recordAutoApproval(env.DB, { approvalId: `done-${i}`, kind: "invoice.reminder", businessId: null, decidedAt: NOW.toISOString(), decidedOn: "2027-01-17", outcome: "sent" });
    await recordAutoApproval(env.DB, { approvalId: "yesterday", kind: "invoice.reminder", businessId: null, decidedAt: "2027-01-16T18:00:00.000Z", decidedOn: "2027-01-16", outcome: "sent" });
    const r = await reminder();
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    expect(await statusOf(r.approval.id)).toBe("pending");
    expect(mail.sent).toHaveLength(0);
    // The next local day has room again. 07:30 UTC on the 18th is still the 17th in Los Angeles (23:30 on the 17th), so the cap still holds there.
    expect(await maybeAutoApprove(e, r.approval, new Date("2027-01-18T07:30:00.000Z"))).toBe("left");
    expect(await maybeAutoApprove(e, r.approval, new Date("2027-01-18T18:00:00.000Z"))).toBe("approved");
    expect(await statusOf(r.approval.id)).toBe("approved");
  });

  it("two sweeps at once cannot pass the cap together: 19 used, three tried at the same moment, one goes", async () => {
    await on("invoice.reminder");
    for (let i = 0; i < AUTO_DAILY_CAP - 1; i++) await recordAutoApproval(env.DB, { approvalId: `done-${i}`, kind: "invoice.reminder", businessId: null, decidedAt: NOW.toISOString(), decidedOn: "2027-01-17", outcome: "sent" });
    const three = [await reminder(), await reminder(), await reminder()];
    const results = await Promise.all(three.map((r) => maybeAutoApprove(e, r.approval, NOW)));
    expect(results.filter((r) => r === "approved")).toHaveLength(1);
    expect(results.filter((r) => r === "left")).toHaveLength(2);
    expect(await countAutoApprovalsOn(env.DB, "2027-01-17")).toBe(AUTO_DAILY_CAP);
    expect(mail.sent).toHaveLength(1);
    expect((await Promise.all(three.map((r) => statusOf(r.approval.id)))).sort()).toEqual(["approved", "pending", "pending"]);
  });

  it("an approval a person already approved takes no place and gets no auto line", async () => {
    await on("invoice.reminder");
    const r = await reminder();
    await env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(r.approval.id).run();
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    expect(await countAutoApprovalsOn(env.DB, "2027-01-17")).toBe(0);
  });

  it("a handler that throws leaves the approval pending with its error and records outcome failed once", async () => {
    await on("invoice.reminder");
    const r = await reminder();
    mail.failures.push(new Error("smtp is down"));
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("failed");
    const after = await approvalRow(r.approval.id);
    expect(after.status).toBe("pending");
    expect(after.error).toContain("smtp is down");
    const rows = await listAutoApprovals(env.DB, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approvalId: r.approval.id, outcome: "failed", error: expect.stringContaining("smtp is down"), businessId: r.businessId });
    expect(await activity(r.businessId)).toEqual([]); // only a success is logged on the client
  });

  it("maybeAutoApprove never throws, even when the approval no longer exists", async () => {
    await on("invoice.reminder");
    const r = await reminder();
    await env.DB.prepare(`DELETE FROM approvals WHERE id = ?`).bind(r.approval.id).run();
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    // A broken database is contained too.
    const broken = { ...e, DB: { prepare: () => { throw new Error("db is gone"); } } } as unknown as Env;
    await expect(maybeAutoApprove(broken, r.approval, NOW)).resolves.toBe("failed");
  });

  it("an approval a person already decided is left and not recorded", async () => {
    await on("invoice.reminder");
    const r = await reminder();
    await env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(r.approval.id).run();
    expect(await maybeAutoApprove(e, r.approval, NOW)).toBe("left");
    expect(await listAutoApprovals(env.DB, 10)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("an approval of any other kind is never approved even with a rule row forged for it", async () => {
    const other = await createApproval(env.DB, { kind: "invoice.send", title: "Send invoice", preview: "x", payload: { invoiceId: "nope" }, record_type: "business", record_id: "b", drafted_by: "logan" });
    await on("invoice.send");
    await on("ladder.mail");
    const ladder = await createApproval(env.DB, { kind: "ladder.mail", title: "Ladder", preview: "x", payload: {}, drafted_by: "job" });
    for (const a of [other, ladder] as Approval[]) {
      expect(await autoEligible(e, a)).toEqual({ ok: false, why: expect.stringContaining("kind") });
      expect(await maybeAutoApprove(e, a, NOW)).toBe("left");
      expect(await statusOf(a.id)).toBe("pending");
    }
    expect(await listAutoApprovals(env.DB, 10)).toHaveLength(0);
  });
});
