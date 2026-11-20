import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  getSubscription, getSubscriptionByStripeId, getSubscriptionByToken, insertPlanned, listSubscriptions, markSubscription, sumActiveMonthlyCents,
} from "../src/worker/db/subscriptions";
import { seedDoc } from "./fixtures/billing";

const plan = (s: Awaited<ReturnType<typeof seedDoc>>, over: Partial<Parameters<typeof insertPlanned>[1]> = {}) => ({
  businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "website_subscription" as const, packageVersion: 1, monthlyCents: 29900,
  startsWhen: "launch" as const, firstChargeOn: null, termMonths: 24, termEndsOn: null, endAction: "convert_to_care" as const, test: false, ...over,
});

describe("subscriptions db", () => {
  it("insertPlanned is unique per document and package", async () => {
    const s = await seedDoc();
    const a = await insertPlanned(env.DB, plan(s));
    expect(a.created).toBe(true);
    expect(a.subscription).toMatchObject({
      businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "website_subscription", packageVersion: 1, monthlyCents: 29900,
      startsWhen: "launch", firstChargeOn: null, termMonths: 24, termEndsOn: null, endAction: "convert_to_care", status: "planned", token: null,
      stripeCustomerId: null, stripeSubscriptionId: null, stripeCheckoutSessionId: null, termNoticeSentAt: null, test: false, activatedAt: null, cancelledAt: null,
    });
    expect(a.subscription.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const b = await insertPlanned(env.DB, plan(s, { monthlyCents: 1 }));
    expect(b.created).toBe(false);
    expect(b.subscription.id).toBe(a.subscription.id);
    expect(b.subscription.monthlyCents).toBe(29900);
    const other = await insertPlanned(env.DB, plan(s, { packageKey: "care" }));
    expect(other.created).toBe(true);
    expect(await getSubscription(env.DB, a.subscription.id)).toEqual(a.subscription);
    expect(await getSubscription(env.DB, "nope")).toBeNull();
  });

  it("monthly money is whole positive cents", async () => {
    const s = await seedDoc();
    await expect(insertPlanned(env.DB, plan(s, { monthlyCents: 0 }))).rejects.toThrow();
    await expect(insertPlanned(env.DB, plan(s, { monthlyCents: 10.5 }))).rejects.toThrow();
  });

  it("markSubscription with from guards the transition", async () => {
    const s = await seedDoc();
    const { subscription: sub } = await insertPlanned(env.DB, plan(s));
    expect(await markSubscription(env.DB, sub.id, { status: "proposed", token: "tok_abc" }, { from: ["planned"] })).toBe(true);
    expect(await markSubscription(env.DB, sub.id, { status: "proposed" }, { from: ["planned"] })).toBe(false);
    expect(await markSubscription(env.DB, sub.id, { status: "link_sent" }, { from: ["proposed"] })).toBe(true);
    expect(await markSubscription(env.DB, sub.id, {
      status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", stripeCheckoutSessionId: "cs_1", activatedAt: "2026-12-20T00:00:00.000Z",
      firstChargeOn: "2027-01-05", termEndsOn: "2029-01-05",
    })).toBe(true);
    expect(await getSubscriptionByToken(env.DB, "tok_abc")).toMatchObject({ id: sub.id, status: "active", stripeSubscriptionId: "sub_1", firstChargeOn: "2027-01-05", termEndsOn: "2029-01-05" });
    expect(await getSubscriptionByStripeId(env.DB, "sub_1")).toMatchObject({ id: sub.id });
    expect(await getSubscriptionByToken(env.DB, "missing")).toBeNull();
    expect(await getSubscriptionByStripeId(env.DB, "missing")).toBeNull();
    expect(await markSubscription(env.DB, "missing", { status: "ended" })).toBe(false);
    expect(await markSubscription(env.DB, sub.id, {})).toBe(false);
    expect(await markSubscription(env.DB, sub.id, { termNoticeSentAt: "2028-12-01T00:00:00.000Z" })).toBe(true);
  });

  it("a token and a Stripe subscription each belong to one row", async () => {
    const a = await seedDoc();
    const b = await seedDoc();
    const x = (await insertPlanned(env.DB, plan(a))).subscription;
    const y = (await insertPlanned(env.DB, plan(b))).subscription;
    await markSubscription(env.DB, x.id, { token: "tok_same", stripeSubscriptionId: "sub_same" });
    await expect(markSubscription(env.DB, y.id, { token: "tok_same" })).rejects.toThrow();
    await expect(markSubscription(env.DB, y.id, { stripeSubscriptionId: "sub_same" })).rejects.toThrow();
  });

  it("lists by status and business, and sums active and past due monthly money", async () => {
    const before = await sumActiveMonthlyCents(env.DB);
    const a = await seedDoc();
    const b = await seedDoc();
    const s1 = (await insertPlanned(env.DB, plan(a, { monthlyCents: 10000 }))).subscription;
    const s2 = (await insertPlanned(env.DB, plan(a, { packageKey: "care", monthlyCents: 5000 }))).subscription;
    const s3 = (await insertPlanned(env.DB, plan(b, { monthlyCents: 7000 }))).subscription;
    await markSubscription(env.DB, s1.id, { status: "active" });
    await markSubscription(env.DB, s2.id, { status: "past_due" });
    await markSubscription(env.DB, s3.id, { status: "cancelled" });
    expect(await sumActiveMonthlyCents(env.DB)).toBe(before + 15000);
    expect((await listSubscriptions(env.DB, { businessId: a.businessId })).map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await listSubscriptions(env.DB, { businessId: a.businessId, statuses: ["past_due"] })).map((s) => s.id)).toEqual([s2.id]);
    expect(await listSubscriptions(env.DB, { businessId: a.businessId, statuses: [] })).toEqual([]);
    expect((await listSubscriptions(env.DB, { statuses: ["cancelled"] })).some((s) => s.id === s3.id)).toBe(true);
  });
});
