import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepBilling } from "../src/worker/billing/sweep";
import { listActivity } from "../src/worker/db/activity";
import { activeHolds } from "../src/worker/db/holds";
import { getInvoice, listInvoices } from "../src/worker/db/invoices";
import { saveSettings } from "../src/worker/db/settings";
import { reachMilestone } from "../src/worker/db/projects";
import { listSubscriptions } from "../src/worker/db/subscriptions";
import { getTask } from "../src/worker/db/tasks";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { REMINDER_CRON, MAIL_SYNC_CRON, runScheduled } from "../src/worker/schedule";
import { activeSub, heldClient, openInvoice, prepareDispatch, seedDraft, seedSignedProject, seedSubscriptionDoc, sentInvoice } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";
import { seedProject } from "./fixtures/projects";
import { KEY, stripeApi } from "./fixtures/stripe";

const e = env as Env;
const E_TEST = { ...env, STRIPE_SECRET_KEY: KEY } as Env;
const E_LIVE = { ...env, STRIPE_SECRET_KEY: "sk_live_LIVEKEYVALUE456" } as Env;
const DAILY = "17 13 * * *";
// 10:00 in Los Angeles, 14 days after the due date 2027-01-20 (the default pause).
const NOW = new Date("2027-02-03T18:00:00.000Z");
const ZERO = { drafted: 0, reminders: 0, holds: 0, started: 0, converted: 0, notices: 0, planned: 0 };

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  mail = await readyToSend();
  await prepareDispatch();
  await saveSettings(env.DB, { billing_config: "{}" });
  // The sweep reads every open invoice, subscription and signed document, and the tests of a file share storage: leftovers are put out of the way.
  await env.DB.batch([
    env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`),
    env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due')`),
    env.DB.prepare(`UPDATE documents SET status = 'void' WHERE status = 'signed'`),
    env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE status = 'pending' AND kind IN ('invoice.send', 'invoice.reminder', 'invoice.pause_notice', 'subscription.start', 'subscription.term_notice')`),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); setMailDeps(null); setStripeFetchForTests(null); });

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const approvalsByKind = async () => {
  const rows = (await env.DB.prepare(`SELECT kind, COUNT(*) AS n FROM approvals WHERE status = 'pending' AND kind IN ('invoice.send', 'invoice.reminder', 'invoice.pause_notice', 'subscription.start', 'subscription.term_notice') GROUP BY kind`).all<{ kind: string; n: number }>()).results;
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
};
const sumOf = (a: Awaited<ReturnType<typeof sweepBilling>>, b: Awaited<ReturnType<typeof sweepBilling>>) => Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + (b as any)[k]]));

/** What `planned` is for the documents `everything` makes: the signed, paid milestone project's document and the care document each plan their own recurring lines. */
const plannedFor = (s: Awaited<ReturnType<typeof everything>>) => s.ms.schedule.recurring.length + s.doc.schedule.recurring.length;

/** One of everything the sweep does: a milestone to draft, an overdue invoice (reminder and hold), a document whose subscription is not planned, and a term that ends soon. */
async function everything() {
  const ms = await seedSignedProject({ option: "c" });
  await reachMilestone(env.DB, ms.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
  const client = await seedProject();
  const overdue = await sentInvoice(client);
  const doc = await seedSubscriptionDoc({ keys: ["care"] });
  const term = await activeSub({ termEndsOn: "2027-02-20" });
  return { ms, client, overdue, doc, term };
}

describe("sweepBilling", () => {
  it("does nothing, and says so, when there is nothing to do", async () => {
    expect(await sweepBilling(e, NOW)).toEqual(ZERO);
  });

  it("drafts, reminds, holds, starts, notices and plans, and reports each count", async () => {
    const s = await everything();
    expect(await sweepBilling(e, NOW)).toEqual({ drafted: 1, reminders: 1, holds: 1, started: 1, converted: 0, notices: 1, planned: plannedFor(s) });
    expect(await approvalsByKind()).toEqual({ "invoice.send": 1, "invoice.reminder": 1, "invoice.pause_notice": 1, "subscription.start": 1, "subscription.term_notice": 1 });
    expect((await activeHolds(env.DB, s.client.businessId)).map((h) => h.invoiceId)).toEqual([s.overdue.id]);
    expect(await listSubscriptions(env.DB, { businessId: s.doc.businessId })).toHaveLength(1);
  });

  it("a sweep twice at one moment makes one of everything", async () => {
    const s = await everything();
    const [x, y] = await Promise.all([sweepBilling(e, NOW), sweepBilling(e, NOW)]);
    expect(sumOf(x, y)).toEqual({ drafted: 1, reminders: 1, holds: 1, started: 1, converted: 0, notices: 1, planned: plannedFor(s) });
    const once = await approvalsByKind();
    expect(once).toEqual({ "invoice.send": 1, "invoice.reminder": 1, "invoice.pause_notice": 1, "subscription.start": 1, "subscription.term_notice": 1 });
    // And a third, later in the same day, adds nothing.
    expect(await sweepBilling(e, new Date(NOW.getTime() + 3_600_000))).toEqual(ZERO);
    expect(await approvalsByKind()).toEqual(once);
    expect(await activeHolds(env.DB, s.client.businessId)).toHaveLength(1);
    expect(await listSubscriptions(env.DB, { businessId: s.doc.businessId })).toHaveLength(1);
    expect((await listInvoices(env.DB, { kinds: ["milestone"], businessId: s.ms.businessId }))).toHaveLength(1);
  });

  it("sends no mail and creates only approvals and holds (and the drafts and planned rows they hang off)", async () => {
    const api = stripeApi({ invoice: (id) => ({ id, status: "open", amount_due: 0, amount_paid: 0, currency: "usd" }) });
    setStripeFetchForTests(api.f);
    await everything();
    const messages = await count(`SELECT COUNT(*) AS n FROM messages`);
    const tasks = await count(`SELECT COUNT(*) AS n FROM claude_tasks`);
    const decided = await count(`SELECT COUNT(*) AS n FROM approvals WHERE status != 'pending'`);
    const sentBefore = await count(`SELECT COUNT(*) AS n FROM invoices WHERE status NOT IN ('draft', 'void')`);
    const result = await sweepBilling(E_TEST, NOW);
    expect(result.drafted + result.reminders + result.holds + result.started + result.notices + result.planned).toBeGreaterThan(0);
    expect(mail.sent).toEqual([]);
    expect(await count(`SELECT COUNT(*) AS n FROM messages`)).toBe(messages);
    expect(await count(`SELECT COUNT(*) AS n FROM claude_tasks`)).toBe(tasks);
    expect(await count(`SELECT COUNT(*) AS n FROM approvals WHERE status != 'pending'`)).toBe(decided); // nothing was approved, rejected or sent
    expect(api.creates()).toEqual([]); // nothing was made at Stripe
    expect(await count(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'draft'`)).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT COUNT(*) AS n FROM invoices WHERE status NOT IN ('draft', 'void')`)).toBe(sentBefore); // the only invoices made are drafts
  });

  describe("settling stale open invoices", () => {
    const paidAtStripe = (amountCents: number) => (id: string) => ({ id, status: "paid", amount_due: 0, amount_paid: amountCents, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/${id}` });

    it("an open invoice whose webhook never came is settled from Stripe", async () => {
      const client = await seedProject();
      const inv = await sentInvoice(client, { dueOn: "2027-03-01" }); // sent 2027-01-13: old; not yet due, so nothing else happens to it
      const api = stripeApi({ invoice: (id) => (id === inv.stripeInvoiceId ? paidAtStripe(inv.amountCents)(id) : { id, status: "open", amount_due: 0, amount_paid: 0, currency: "usd" }) });
      setStripeFetchForTests(api.f);
      await sweepBilling(E_TEST, NOW);
      expect(await getInvoice(env.DB, inv.id)).toMatchObject({ status: "paid", mismatch: null });
      expect((await getInvoice(env.DB, inv.id))!.paidAt).toMatch(/^\d{4}-/);
      expect((await listActivity(env.DB, client.businessId)).filter((a) => a.kind === "invoice_paid")).toHaveLength(1); // the webhook's own paid path ran
      const asked = api.calls.filter((c) => c.method === "GET").length;
      await sweepBilling(E_TEST, NOW); // paid is final: not asked again, not logged again
      expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(asked);
      expect((await listActivity(env.DB, client.businessId)).filter((a) => a.kind === "invoice_paid")).toHaveLength(1);
    });

    it("an invoice paid at Stripe whose webhook never came is settled FIRST: no reminder, pause notice or hold in the same run", async () => {
      const client = await seedProject();
      const inv = await sentInvoice(client); // sent 2027-01-13, due long before NOW: a reminder and the +14 hold are both due today
      const api = stripeApi({ invoice: (id) => (id === inv.stripeInvoiceId ? paidAtStripe(inv.amountCents)(id) : { id, status: "open", amount_due: 0, amount_paid: 0, currency: "usd" }) });
      setStripeFetchForTests(api.f);
      const r = await sweepBilling(E_TEST, NOW);
      expect(await getInvoice(env.DB, inv.id)).toMatchObject({ status: "paid", mismatch: null });
      expect(r).toMatchObject({ reminders: 0, holds: 0 });
      expect(await approvalsByKind()).toEqual({});
      expect(await activeHolds(env.DB, client.businessId)).toEqual([]);
      expect(await count(`SELECT COUNT(*) AS n FROM invoice_nudges WHERE invoice_id = '${inv.id}'`)).toBe(0);
    });

    it("a payment of another amount is a mismatch and changes nothing else", async () => {
      const client = await seedProject();
      const inv = await sentInvoice(client, { dueOn: "2027-03-01" });
      const api = stripeApi({ invoice: (id) => ({ ...paidAtStripe(100)(id) }) });
      setStripeFetchForTests(api.f);
      await sweepBilling(E_TEST, NOW);
      expect(await getInvoice(env.DB, inv.id)).toMatchObject({ status: "open", paidAt: null, mismatch: expect.stringMatching(/amount paid 100/) });
    });

    it("an invoice voided or written off at Stripe is brought up to date, its hold lifted and its waiting step sent", async () => {
      for (const stripeStatus of ["void", "uncollectible"] as const) {
        await prepareDispatch();
        const c = await heldClient(); // open since 2026-12-20, hold in place
        const api = stripeApi({ invoice: (id) => ({ id, status: stripeStatus, amount_due: 0, amount_paid: 0, currency: "usd" }) });
        setStripeFetchForTests(api.f);
        expect((await getTask(env.DB, c.step.id))!.status).toBe("todo");
        await sweepBilling(E_TEST, NOW);
        expect((await getInvoice(env.DB, c.invoice.id))!.status, stripeStatus).toBe(stripeStatus === "void" ? "void" : "uncollectible");
        expect(await activeHolds(env.DB, c.businessId), stripeStatus).toEqual([]);
        expect((await getTask(env.DB, c.step.id))!.status, stripeStatus).toBe("in_progress");
      }
    });

    it("an invoice still open at Stripe, a young one, a draft and a test copy under a live key are left alone", async () => {
      const client = await seedProject();
      const old = await sentInvoice(client, { dueOn: "2027-03-01" });
      const young = await openInvoice((await seedDraft({ seed: client as never })).invoice);
      await env.DB.prepare(`UPDATE invoices SET sent_at = ? WHERE id = ?`).bind("2027-02-03T10:00:00.000Z", young.id).run(); // an hour before NOW's... under a day
      const test = await sentInvoice(client, { dueOn: "2027-03-01" });
      await env.DB.prepare(`UPDATE invoices SET test = 1 WHERE id = ?`).bind(test.id).run();
      const draft = (await seedDraft({ seed: client as never })).invoice;
      const api = stripeApi({ invoice: (id) => ({ id, status: "paid", amount_due: 0, amount_paid: 100000, currency: "usd" }) });
      setStripeFetchForTests(api.f);
      // Under a live key a test copy is never touched, and a young invoice is left to its webhook.
      await sweepBilling(E_LIVE, NOW);
      const asked = api.calls.map((c) => c.url);
      expect(asked.some((u) => u.endsWith(old.stripeInvoiceId!))).toBe(true);
      expect(asked.some((u) => u.endsWith(young.stripeInvoiceId!))).toBe(false);
      expect(asked.some((u) => u.endsWith(test.stripeInvoiceId!))).toBe(false);
      expect((await getInvoice(env.DB, young.id))!.status).toBe("open");
      expect((await getInvoice(env.DB, test.id))!.status).toBe("open");
      expect((await getInvoice(env.DB, draft.id))!.status).toBe("draft");
    });

    it("with no Stripe key, or with Stripe down, the sweep goes on and nothing changes", async () => {
      const client = await seedProject();
      const inv = await sentInvoice(client, { dueOn: "2027-03-01" });
      const api = stripeApi({ fail: () => new Response("{}", { status: 500 }) });
      setStripeFetchForTests(api.f);
      await expect(sweepBilling(e, NOW)).resolves.toEqual(ZERO);
      expect(api.calls).toHaveLength(0);
      await expect(sweepBilling(E_TEST, NOW)).resolves.toEqual(ZERO);
      expect(api.calls.length).toBeGreaterThan(0);
      expect((await getInvoice(env.DB, inv.id))!.status).toBe("open");
      expect(String(errors.mock.calls.map((c: unknown[]) => c.join(" ")))).not.toContain(KEY);
    });
  });

  describe("planning subscriptions nobody planned", () => {
    it("a paid real document with no subscription rows gets them, a test or unpaid one gets none, and a second sweep adds none", async () => {
      const real = await seedSubscriptionDoc({ keys: ["website_subscription", "care"] });
      const test = await seedSubscriptionDoc({ keys: ["care"], test: true });
      const unpaid = await seedSubscriptionDoc({ keys: ["care"], paid: false });
      const one = await sweepBilling(e, NOW);
      expect(one.planned).toBe(real.schedule.recurring.length);
      expect(one.planned).toBeGreaterThan(0);
      expect((await listSubscriptions(env.DB, { businessId: real.businessId })).map((s) => s.packageKey).sort()).toEqual(real.schedule.recurring.map((r) => r.key).sort());
      expect(await listSubscriptions(env.DB, { businessId: test.businessId })).toEqual([]);
      expect(await listSubscriptions(env.DB, { businessId: unpaid.businessId })).toEqual([]);
      expect((await sweepBilling(e, NOW)).planned).toBe(0);
      expect(await listSubscriptions(env.DB, { businessId: real.businessId })).toHaveLength(real.schedule.recurring.length);
    });
  });

  describe("one part failing", () => {
    /** An env whose database throws for any statement matching `re`: stands in for one part of the sweep failing. */
    const failing = (re: RegExp) => ({
      ...env,
      DB: new Proxy(env.DB, {
        get(t, p) {
          if (p === "prepare") return (sql: string) => { if (re.test(sql)) throw new Error("db down"); return t.prepare(sql); };
          const v = (t as any)[p];
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    }) as Env;

    it("is logged, and the parts after it still run", async () => {
      const s = await everything();
      // The start step and the term step both list the subscriptions by status; the plan step looks at documents, the hold step at invoices.
      const result = await sweepBilling(failing(/FROM subscriptions WHERE status IN/), NOW);
      expect(result).toMatchObject({ drafted: 1, reminders: 1, holds: 1, started: 0, notices: 0, converted: 0, planned: plannedFor(s) });
      expect((await activeHolds(env.DB, s.client.businessId))).toHaveLength(1);
      expect(String(errors.mock.calls.map((c: unknown[]) => c.join(" ")))).toContain("db down");
    });

    it("the cron's daily run reaches the billing sweep and survives one part throwing", async () => {
      const s = await everything();
      const run = runScheduled(failing(/FROM subscriptions WHERE status IN/), DAILY, NOW);
      await expect(run).resolves.toBeUndefined();
      expect((await activeHolds(env.DB, s.client.businessId))).toHaveLength(1); // a part after the one that threw
      expect(await listSubscriptions(env.DB, { businessId: s.doc.businessId })).toHaveLength(1); // planned by the sweep
      expect(await count(`SELECT COUNT(*) AS n FROM invoices WHERE kind = 'milestone' AND status = 'draft' AND business_id = '${s.ms.businessId}'`)).toBe(1);
      expect(mail.sent).toEqual([]);
    });

    it("the 15-minute and 5-minute crons do not run it", async () => {
      await seedSubscriptionDoc({ keys: ["care"] });
      await runScheduled(e, MAIL_SYNC_CRON, NOW);
      await runScheduled(e, REMINDER_CRON, NOW);
      expect(await count(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'planned'`)).toBe(0);
      await runScheduled(e, DAILY, NOW);
      expect(await count(`SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('planned', 'proposed')`)).toBeGreaterThan(0);
    });
  });
});
