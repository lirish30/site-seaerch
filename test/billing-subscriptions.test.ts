import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reject } from "../src/worker/approvals/decide";
import { planSubscriptions, proposeSubscription, startDueSubscriptions, startKickoff, subscriptionDoneHook } from "../src/worker/billing/subscriptions";
import { getDocument } from "../src/worker/db/documents";
import { insertInvoice } from "../src/worker/db/invoices";
import { onInvoicePaid } from "../src/worker/documents/deposit";
import { markProjectDone } from "../src/worker/db/projects";
import { getSubscription, insertPlanned, listSubscriptions } from "../src/worker/db/subscriptions";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onProjectDone, runProjectDone } from "../src/worker/projects/hooks";
import { seedSubscriptionDoc } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";

const e = env as Env;
// 10:00 on 2026-12-20 in Los Angeles.
const NOW = new Date("2026-12-20T18:00:00.000Z");
const TODAY = "2026-12-20";
// The done hook reads "today" from the mail clock, which the test fixtures set to 2026-12-01.
const HOOK_DAY = "2026-12-01";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await readyToSend();
  // The sweep looks at every planned subscription, and the tests of a file share storage: leftovers from an earlier test are put out of the way.
  await env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE status IN ('planned', 'proposed')`).run();
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

/** The signed document for these packages, with its subscriptions planned. */
async function planned(keys: Parameters<typeof seedSubscriptionDoc>[0]["keys"], o: Partial<Parameters<typeof seedSubscriptionDoc>[0]> = {}) {
  const s = await seedSubscriptionDoc({ keys, ...o });
  const doc = (await getDocument(env.DB, s.documentId))!;
  await planSubscriptions(e, doc);
  const subs = (await listSubscriptions(env.DB, { businessId: s.businessId })).reverse();
  return { ...s, doc, subs };
}
const waiting = async (subscriptionId: string) =>
  (await env.DB.prepare(`SELECT id, status FROM approvals WHERE kind = 'subscription.start' AND json_extract(payload, '$.subscriptionId') = ? ORDER BY created_at, id`).bind(subscriptionId).all<{ id: string; status: string }>()).results;
const finish = async (projectId: string) => { expect(await markProjectDone(env.DB, projectId, "2026-12-19T10:00:00.000Z")).toBe(true); };

describe("planSubscriptions", () => {
  it("a signed website subscription plans one row that converts to care, with 24 months", async () => {
    const s = await planned(["website_subscription"]);
    expect(s.subs).toHaveLength(1);
    expect(s.subs[0]).toMatchObject({
      businessId: s.businessId, documentId: s.documentId, packageKey: "website_subscription", packageVersion: 1, monthlyCents: 29700, startsWhen: "launch",
      firstChargeOn: null, termMonths: 24, termEndsOn: null, endAction: "convert_to_care", status: "planned", token: null, stripeSubscriptionId: null, test: false,
    });
  });

  it("care, local seo and a build's care each plan once", async () => {
    const care = await planned(["care"]);
    expect(care.subs).toHaveLength(1);
    expect(care.subs[0]).toMatchObject({ packageKey: "care", monthlyCents: 12900, startsWhen: "signing", termMonths: null, endAction: "none" });

    const seo = await planned(["local_seo"]);
    expect(seo.subs).toHaveLength(1);
    expect(seo.subs[0]).toMatchObject({ packageKey: "local_seo", monthlyCents: 79700, startsWhen: "kickoff", termMonths: 6, endAction: "none" });

    const build = await planned(["starter_site", "care"], { build: true });
    expect(build.subs).toHaveLength(1); // the site is one-time: only its care recurs
    expect(build.subs[0]).toMatchObject({ packageKey: "care", startsWhen: "launch", endAction: "none" });
  });

  it("planning twice adds nothing", async () => {
    const s = await planned(["website_subscription", "care"]);
    expect(s.subs).toHaveLength(2);
    expect(await planSubscriptions(e, s.doc)).toBe(0);
    expect(await listSubscriptions(env.DB, { businessId: s.businessId })).toHaveLength(2);
  });

  it("a test document plans nothing", async () => {
    const s = await seedSubscriptionDoc({ keys: ["website_subscription"], test: true });
    const doc = (await getDocument(env.DB, s.documentId))!;
    expect(doc.test).toBe(true);
    expect(await planSubscriptions(e, doc)).toBe(0);
    expect(await listSubscriptions(env.DB, { businessId: s.businessId })).toHaveLength(0);
  });

  it("a document that is not signed plans nothing", async () => {
    const s = await seedSubscriptionDoc({ keys: ["care"] });
    const doc = (await getDocument(env.DB, s.documentId))!;
    expect(await planSubscriptions(e, { ...doc, status: "sent" })).toBe(0);
    expect(await listSubscriptions(env.DB, { businessId: s.businessId })).toHaveLength(0);
  });
});

describe("paying the deposit", () => {
  const pay = async (s: Awaited<ReturnType<typeof seedSubscriptionDoc>>, test = false) => onInvoicePaid(e, await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`,
    amountCents: s.schedule.depositCents, hostedUrl: "https://invoice.stripe.com/i/x", test,
  }));

  it("plans the document's subscriptions, once", async () => {
    const s = await seedSubscriptionDoc({ keys: ["website_subscription", "care"], paid: false });
    await pay(s);
    expect((await listSubscriptions(env.DB, { businessId: s.businessId })).map((x) => x.packageKey).sort()).toEqual(["care", "website_subscription"]);
    await pay(s).catch(() => {}); // a replayed payment (the webhook's retry) plans nothing more
    expect(await listSubscriptions(env.DB, { businessId: s.businessId })).toHaveLength(2);
    expect((await getDocument(env.DB, s.documentId))!.paidAt).not.toBeNull();
  });

  it("a test copy's payment plans nothing", async () => {
    const s = await seedSubscriptionDoc({ keys: ["care"], test: true, paid: false });
    await pay(s, true);
    expect(await listSubscriptions(env.DB, { businessId: s.businessId })).toHaveLength(0);
    expect((await getDocument(env.DB, s.documentId))!.paidAt).not.toBeNull();
  });
});

describe("starting subscriptions", () => {
  it("signing-start: first charge is one month after the deposit", async () => {
    const s = await planned(["care"], { paidAt: "2026-12-02T09:00:00.000Z" });
    expect(await startDueSubscriptions(e, NOW)).toBe(1);
    const sub = (await getSubscription(env.DB, s.subs[0].id))!;
    expect(sub).toMatchObject({ status: "proposed", firstChargeOn: "2027-01-02" });
    const [a] = await waiting(sub.id);
    expect(a.status).toBe("pending");
    // Run again: nothing more.
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    expect(await waiting(sub.id)).toHaveLength(1);
  });

  it("signing-start: the paid date is the owner's calendar day, and a month clamps to the end of a short one", async () => {
    // 2027-01-31 18:00 UTC is still the 31st in Los Angeles: one month on is 28 February.
    const s = await planned(["care"], { paidAt: "2027-01-31T18:00:00.000Z" });
    await startDueSubscriptions(e, NOW);
    expect((await getSubscription(env.DB, s.subs[0].id))!.firstChargeOn).toBe("2027-02-28");
    // 2027-03-01 03:00 UTC is still 28 February in Los Angeles.
    const t = await planned(["care"], { paidAt: "2027-03-01T03:00:00.000Z" });
    await startDueSubscriptions(e, NOW);
    expect((await getSubscription(env.DB, t.subs[0].id))!.firstChargeOn).toBe("2027-03-28");
  });

  it("an unpaid document starts nothing", async () => {
    const s = await planned(["care"], { paid: false });
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    expect((await getSubscription(env.DB, s.subs[0].id))!.status).toBe("planned");
  });

  it("launch-start: nothing until the build project is done, then one proposal; the hook and the daily sweep make one", async () => {
    const s = await planned(["website_subscription"], { build: true });
    const id = s.subs[0].id;
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    await subscriptionDoneHook(e, s.project!); // an active project is not finished: the hook proposes nothing
    expect((await getSubscription(env.DB, id))!.status).toBe("planned");

    await finish(s.project!.id);
    onProjectDone(subscriptionDoneHook);
    await runProjectDone(e, s.project!);
    // The first month of a website subscription is not in the deposit, so it is charged the day the site launches.
    expect(await getSubscription(env.DB, id)).toMatchObject({ status: "proposed", firstChargeOn: HOOK_DAY, projectId: s.project!.id });
    expect(await waiting(id)).toHaveLength(1);
    // The sweep finds it already proposed; a replayed hook does too.
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    await runProjectDone(e, s.project!);
    expect(await waiting(id)).toHaveLength(1);
  });

  it("launch-start: the sweep alone proposes it when the hook never ran", async () => {
    const s = await planned(["website_subscription"], { build: true });
    await finish(s.project!.id);
    expect(await startDueSubscriptions(e, NOW)).toBe(1);
    expect(await getSubscription(env.DB, s.subs[0].id)).toMatchObject({ status: "proposed", firstChargeOn: TODAY });
    onProjectDone(subscriptionDoneHook);
    await runProjectDone(e, s.project!);
    expect(await waiting(s.subs[0].id)).toHaveLength(1);
  });

  it("a cancelled build starts nothing", async () => {
    const cancelled = await planned(["website_subscription"], { build: true });
    await env.DB.prepare(`UPDATE projects SET status = 'cancelled' WHERE id = ?`).bind(cancelled.project!.id).run();
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    expect((await getSubscription(env.DB, cancelled.subs[0].id))!.status).toBe("planned");
  });

  it("kickoff never starts by itself and starts when Logan asks", async () => {
    const s = await planned(["local_seo"]);
    const id = s.subs[0].id;
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    expect((await getSubscription(env.DB, id))!.status).toBe("planned");
    // The setup fee is in the deposit, but the first month is not: it is charged the day Logan starts billing.
    const a = await startKickoff(e, id, NOW);
    expect(a).toMatchObject({ kind: "subscription.start", status: "pending", payload: { subscriptionId: id } });
    expect(await getSubscription(env.DB, id)).toMatchObject({ status: "proposed", firstChargeOn: TODAY });
    // Pressing it again returns the same waiting approval.
    expect((await startKickoff(e, id, NOW)).id).toBe(a.id);
  });

  it("a kickoff entry with a prepaid first month charges one month after Start billing, not on the day", async () => {
    const s = await planned(["local_seo_growth"]);
    expect(s.schedule.recurring[0].firstMonthPrepaid).toBe(true);
    await startKickoff(e, s.subs[0].id, NOW);
    expect((await getSubscription(env.DB, s.subs[0].id))!.firstChargeOn).toBe("2027-01-20");
  });

  it("Start billing refuses what is not a waiting kickoff subscription", async () => {
    const care = await planned(["care"]);
    await expect(startKickoff(e, care.subs[0].id, NOW)).rejects.toThrow(/kickoff/);
    await expect(startKickoff(e, crypto.randomUUID(), NOW)).rejects.toThrow(/no such subscription/i);
    const unpaid = await planned(["local_seo"], { paid: false });
    await expect(startKickoff(e, unpaid.subs[0].id, NOW)).rejects.toThrow(/deposit/);
    const active = await planned(["local_seo"]);
    await env.DB.prepare(`UPDATE subscriptions SET status = 'active' WHERE id = ?`).bind(active.subs[0].id).run();
    await expect(startKickoff(e, active.subs[0].id, NOW)).rejects.toThrow(/active/);
  });
});

describe("proposeSubscription", () => {
  it("shows the plan, the price, the first charge, the term and the exact mail", async () => {
    const s = await planned(["website_subscription"]);
    const a = await proposeSubscription(e, s.subs[0].id, "2027-02-10");
    expect(a).toMatchObject({ kind: "subscription.start", status: "pending", payload: { subscriptionId: s.subs[0].id }, record_type: "business", record_id: s.businessId });
    expect(a.title).toContain("Website Subscription");
    expect(a.title).toContain("Ace Plumbing");
    for (const part of [
      "To: Pat Jones <pat@ace.test>", "Website Subscription", "$297 a month", "First charge: February 10, 2027", "Term: 24 months",
      "https://clients.hellositeline.test/s/(the link is made when you approve)", "Nothing is mailed",
    ]) expect(a.preview, part).toContain(part);
    expect(await getSubscription(env.DB, s.subs[0].id)).toMatchObject({ status: "proposed", firstChargeOn: "2027-02-10" });
  });

  it("one waiting approval per subscription", async () => {
    const s = await planned(["care"]);
    const a = await proposeSubscription(e, s.subs[0].id, "2027-02-10");
    expect((await proposeSubscription(e, s.subs[0].id, "2027-02-10")).id).toBe(a.id);
    expect(await waiting(s.subs[0].id)).toHaveLength(1);
  });

  it("a rejected proposal can be proposed again", async () => {
    const s = await planned(["care"]);
    const a = await proposeSubscription(e, s.subs[0].id, "2027-02-10");
    expect(await reject(env.DB, a.id, "not yet")).toBe(true);
    // The sweep leaves it alone (Logan said no), but he can put it up again, with another date.
    expect(await startDueSubscriptions(e, NOW)).toBe(0);
    const b = await proposeSubscription(e, s.subs[0].id, "2027-03-01");
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("pending");
    expect(await getSubscription(env.DB, s.subs[0].id)).toMatchObject({ status: "proposed", firstChargeOn: "2027-03-01" });
  });

  it("refuses a subscription that is not waiting to be proposed, a bad date and an unknown id", async () => {
    const s = await planned(["care"]);
    await expect(proposeSubscription(e, crypto.randomUUID(), "2027-02-10")).rejects.toThrow(/no such subscription/i);
    await expect(proposeSubscription(e, s.subs[0].id, "next month")).rejects.toThrow(/date/);
    await env.DB.prepare(`UPDATE subscriptions SET status = 'link_sent' WHERE id = ?`).bind(s.subs[0].id).run();
    await expect(proposeSubscription(e, s.subs[0].id, "2027-02-10")).rejects.toThrow(/link_sent|already/);
  });

  it("a hand-made test subscription can be proposed, and says it is a test", async () => {
    const s = await seedSubscriptionDoc({ keys: ["care"], test: true });
    const { subscription } = await insertPlanned(env.DB, {
      businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "care", packageVersion: 1, monthlyCents: 12900, startsWhen: "signing", firstChargeOn: null,
      termMonths: null, termEndsOn: null, endAction: "none", test: true,
    });
    const a = await proposeSubscription(e, subscription.id, "2027-02-10");
    expect(a.preview).toContain("(a test: nothing goes to");
    expect(a.preview).toContain("[Test] ");
  });
});
