import { describe, expect, it } from "vitest";
import { arAging, bookedNotBilled, churn, freedomProgress, revenueByMonth } from "../src/worker/money/figures";
import type { InvoiceRow } from "../src/worker/db/invoices";
import type { Subscription } from "../src/worker/db/subscriptions";

const ZONE = "America/Los_Angeles";

let n = 0;
const inv = (o: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: `inv_${++n}`, businessId: "b1", dealId: null, documentId: null, projectId: null, changeOrderId: null, subscriptionId: null, kind: "milestone", ref: `ref_${n}`, test: false,
  description: "x", lines: [], stripeCustomerId: null, stripeInvoiceId: null, amountCents: 100_000, status: "open", hostedUrl: null, dueOn: null, sentAt: null, failedOn: null,
  mismatch: null, createdAt: "2027-01-01T00:00:00.000Z", paidAt: null, ...o,
});
const paid = (paidAt: string, o: Partial<InvoiceRow> = {}) => inv({ status: "paid", paidAt, ...o });

const NOW = new Date("2027-03-15T20:00:00.000Z");
const DAY = 86_400_000;
const sub = (o: Partial<Subscription> = {}): Subscription => ({
  id: `sub_${++n}`, businessId: "b1", documentId: "d1", projectId: null, packageKey: "care", packageVersion: 1, monthlyCents: 10_000, startsWhen: "signing", firstChargeOn: null, termMonths: null,
  termEndsOn: null, endAction: "none", status: "active", token: null, stripeCustomerId: null, stripeSubscriptionId: null, stripeCheckoutSessionId: null, termNoticeSentAt: null, test: false,
  createdAt: "2026-01-01T00:00:00.000Z", activatedAt: null, cancelledAt: null, ...o,
});

describe("revenueByMonth", () => {
  it("counts a payment by the day it fell on in the booking zone: 11:30 pm on Dec 31 in Los Angeles is December", () => {
    const r = revenueByMonth([paid("2027-01-01T07:30:00.000Z", { amountCents: 50_000 })], ZONE, "2027-01", 2);
    expect(r).toEqual([{ month: "2026-12", cents: 50_000 }, { month: "2027-01", cents: 0 }]);
  });

  it("counts the same instant in January for a zone already into the new year", () => {
    const r = revenueByMonth([paid("2027-01-01T07:30:00.000Z", { amountCents: 50_000 })], "Europe/Berlin", "2027-01", 2);
    expect(r).toEqual([{ month: "2026-12", cents: 0 }, { month: "2027-01", cents: 50_000 }]);
  });

  it("returns count months, oldest first, zeros for the empty ones, across a year boundary", () => {
    const r = revenueByMonth([], ZONE, "2027-02", 6);
    expect(r.map((m) => m.month)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(r.every((m) => m.cents === 0)).toBe(true);
  });

  it("adds paid real invoices only: draft, void, uncollectible, open, failed and test add nothing", () => {
    const at = "2027-02-10T18:00:00.000Z";
    const rows = [
      paid(at, { amountCents: 10_000 }), paid(at, { amountCents: 2_500 }),
      inv({ status: "draft", paidAt: at }), inv({ status: "void", paidAt: at }), inv({ status: "uncollectible", paidAt: at }), inv({ status: "open", paidAt: at }), inv({ status: "failed", paidAt: at }),
      paid(at, { test: true, amountCents: 99_999 }),
    ];
    expect(revenueByMonth(rows, ZONE, "2027-02", 1)).toEqual([{ month: "2027-02", cents: 12_500 }]);
  });

  it("leaves out payments outside the window and a paid row with no date", () => {
    const rows = [paid("2026-01-10T18:00:00.000Z"), paid("2027-03-01T18:00:00.000Z"), inv({ status: "paid", paidAt: null })];
    expect(revenueByMonth(rows, ZONE, "2027-02", 2).map((m) => m.cents)).toEqual([0, 0]);
  });

  it("a count of 0 is an empty list", () => {
    expect(revenueByMonth([paid("2027-02-10T18:00:00.000Z")], ZONE, "2027-02", 0)).toEqual([]);
  });
});

describe("arAging", () => {
  const TODAY = "2027-03-15";
  const due = (daysLate: number) => { const d = new Date(Date.UTC(2027, 2, 15) - daysLate * DAY); return d.toISOString().slice(0, 10); };
  const bucket = (r: ReturnType<typeof arAging>, key: string) => r.buckets.find((b) => b.key === key)!;

  it("puts due today and not yet due in current, one day late in d1_30, 31 days in d31_60 and 61 in d61_plus", () => {
    const rows = [
      inv({ dueOn: due(0), amountCents: 1_000 }), inv({ dueOn: due(-5), amountCents: 2_000 }),
      inv({ dueOn: due(1), amountCents: 4_000 }), inv({ dueOn: due(30), amountCents: 8_000 }),
      inv({ dueOn: due(31), amountCents: 16_000 }), inv({ dueOn: due(60), amountCents: 32_000 }),
      inv({ dueOn: due(61), amountCents: 64_000 }),
    ];
    const r = arAging(rows, TODAY);
    expect(r.buckets.map((b) => b.key)).toEqual(["current", "d1_30", "d31_60", "d61_plus"]);
    expect(r.buckets.map((b) => [b.cents, b.count])).toEqual([[3_000, 2], [12_000, 2], [48_000, 2], [64_000, 1]]);
    expect(r.openCents).toBe(127_000);
  });

  it("an invoice with no due date is current; a failed one counts from the day it failed", () => {
    const r = arAging([inv({ dueOn: null, amountCents: 5_000 }), inv({ status: "failed", dueOn: due(0), failedOn: due(40), amountCents: 7_000 })], TODAY);
    expect(bucket(r, "current")).toMatchObject({ cents: 5_000, count: 1 });
    expect(bucket(r, "d31_60")).toMatchObject({ cents: 7_000, count: 1 });
  });

  it("leaves out paid, draft, void, uncollectible and test invoices", () => {
    const r = arAging([paid("2027-03-01T00:00:00.000Z", { dueOn: due(10) }), inv({ status: "draft", dueOn: due(10) }), inv({ status: "void", dueOn: due(10) }), inv({ status: "uncollectible", dueOn: due(10) }), inv({ dueOn: due(10), test: true })], TODAY);
    expect(r.openCents).toBe(0);
    expect(r.oldest).toEqual([]);
    expect(r.buckets.every((b) => b.cents === 0 && b.count === 0)).toBe(true);
  });

  it("lists the overdue invoices most overdue first, at most ten", () => {
    const rows = Array.from({ length: 12 }, (_, i) => inv({ id: `i${i}`, businessId: `b${i}`, dueOn: due(i + 1), amountCents: 1_000 + i }));
    rows.push(inv({ id: "current", dueOn: due(0) }));
    const r = arAging(rows, TODAY);
    expect(r.oldest).toHaveLength(10);
    expect(r.oldest.map((o) => o.invoiceId)).toEqual(["i11", "i10", "i9", "i8", "i7", "i6", "i5", "i4", "i3", "i2"]);
    expect(r.oldest[0]).toEqual({ invoiceId: "i11", businessId: "b11", amountCents: 1_011, daysOverdue: 12 });
  });

  it("an empty list gives zeros", () => {
    const r = arAging([], TODAY);
    expect(r.openCents).toBe(0);
    expect(r.buckets).toHaveLength(4);
  });
});

describe("churn", () => {
  it("counts a cancellation 29 days ago and not one 31 days ago", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
    const r = churn([sub({ status: "cancelled", cancelledAt: at(29), monthlyCents: 10_000 }), sub({ status: "cancelled", cancelledAt: at(31), monthlyCents: 90_000 }), sub({ monthlyCents: 30_000 })], NOW);
    expect(r.churnedLast30Cents).toBe(10_000);
    expect(r.churnRatePct).toBe(25); // 10 000 / (30 000 live + 10 000 churned)
  });

  it("a cancellation exactly 30 days ago counts (the window starts at now minus 30 days, inclusive); one second earlier does not", () => {
    const exact = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const early = new Date(NOW.getTime() - 30 * DAY - 1000).toISOString();
    expect(churn([sub({ status: "cancelled", cancelledAt: exact, monthlyCents: 5_000 })], NOW).churnedLast30Cents).toBe(5_000);
    expect(churn([sub({ status: "cancelled", cancelledAt: early, monthlyCents: 5_000 })], NOW).churnedLast30Cents).toBe(0);
  });

  it("an ended (term end) subscription is not churn, nor is a test row, nor a cancelled one with no date", () => {
    const recent = new Date(NOW.getTime() - 2 * DAY).toISOString();
    const r = churn([
      sub({ status: "ended", cancelledAt: recent, monthlyCents: 10_000 }), sub({ status: "cancelled", cancelledAt: recent, test: true, monthlyCents: 10_000 }), sub({ status: "cancelled", cancelledAt: null, monthlyCents: 10_000 }),
      sub({ monthlyCents: 20_000 }),
    ], NOW);
    expect(r).toEqual({ churnedLast30Cents: 0, churnRatePct: 0 });
  });

  it("no live MRR and no churn gives null, never NaN", () => {
    expect(churn([], NOW)).toEqual({ churnedLast30Cents: 0, churnRatePct: null });
    expect(churn([sub({ status: "planned" }), sub({ status: "active", test: true })], NOW)).toEqual({ churnedLast30Cents: 0, churnRatePct: null });
  });

  it("all of the MRR churned is 100 percent", () => {
    const recent = new Date(NOW.getTime() - 2 * DAY).toISOString();
    expect(churn([sub({ status: "cancelled", cancelledAt: recent, monthlyCents: 12_900 })], NOW)).toEqual({ churnedLast30Cents: 12_900, churnRatePct: 100 });
  });

  it("rounds the rate to one decimal", () => {
    const recent = new Date(NOW.getTime() - 2 * DAY).toISOString();
    expect(churn([sub({ status: "cancelled", cancelledAt: recent, monthlyCents: 10_000 }), sub({ monthlyCents: 20_000 })], NOW).churnRatePct).toBe(33.3);
  });
});

describe("bookedNotBilled", () => {
  const doc = (o: Partial<{ id: string; dealId: string; businessId: string; milestoneCents: number }> = {}) => ({ id: "d1", dealId: "deal1", businessId: "b1", milestoneCents: 200_000, ...o });

  it("a $2,000 schedule with a paid $1,000 deposit leaves $1,000", () => {
    const r = bookedNotBilled({ documents: [doc()], signedOrders: [], invoices: [paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "deposit", amountCents: 100_000 })] });
    expect(r.cents).toBe(100_000);
    expect(r.rows).toEqual([{ businessId: "b1", bookedCents: 200_000, billedCents: 100_000, cents: 100_000 }]);
  });

  it("open and failed invoices count as billed; draft, void and uncollectible do not reduce it", () => {
    const base = { documentId: "d1", kind: "milestone" as const, amountCents: 10_000 };
    const r = bookedNotBilled({
      documents: [doc()], signedOrders: [],
      invoices: [inv({ ...base, status: "open" }), inv({ ...base, status: "failed" }), inv({ ...base, status: "draft" }), inv({ ...base, status: "void" }), inv({ ...base, status: "uncollectible" })],
    });
    expect(r.cents).toBe(180_000);
  });

  it("test invoices and invoices of other kinds or other documents do not reduce it", () => {
    const r = bookedNotBilled({
      documents: [doc()], signedOrders: [],
      invoices: [
        paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "deposit", amountCents: 5_000, test: true }),
        paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "subscription", amountCents: 5_000 }),
        paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "hourly", amountCents: 5_000 }),
        paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "change_order", changeOrderId: "co9", amountCents: 5_000 }),
        paid("2027-01-01T00:00:00.000Z", { documentId: "other", kind: "deposit", amountCents: 5_000 }),
      ],
    });
    expect(r.cents).toBe(200_000);
  });

  it("a signed change order with no invoice adds its price; its own invoice reduces only it", () => {
    const orders = [{ id: "co1", businessId: "b1", priceCents: 30_000 }];
    expect(bookedNotBilled({ documents: [], signedOrders: orders, invoices: [] }).cents).toBe(30_000);
    const r = bookedNotBilled({
      documents: [doc()], signedOrders: orders,
      invoices: [inv({ kind: "change_order", changeOrderId: "co1", documentId: "d1", status: "open", amountCents: 30_000 })],
    });
    expect(r.cents).toBe(200_000);
  });

  it("overbilling clamps to 0 and never offsets another document", () => {
    const r = bookedNotBilled({
      documents: [doc(), doc({ id: "d2", milestoneCents: 50_000 })], signedOrders: [],
      invoices: [paid("2027-01-01T00:00:00.000Z", { documentId: "d1", kind: "milestone", amountCents: 250_000 })],
    });
    expect(r.cents).toBe(50_000);
    expect(r.rows).toEqual([
      { businessId: "b1", bookedCents: 250_000, billedCents: 250_000, cents: 50_000 },
    ]);
  });

  it("rows are per business, largest first, and the total is their sum", () => {
    const r = bookedNotBilled({
      documents: [doc({ id: "d1", businessId: "b1", milestoneCents: 10_000 }), doc({ id: "d2", businessId: "b2", milestoneCents: 90_000 })], signedOrders: [{ id: "co1", businessId: "b1", priceCents: 5_000 }], invoices: [],
    });
    expect(r.rows.map((x) => [x.businessId, x.cents])).toEqual([["b2", 90_000], ["b1", 15_000]]);
    expect(r.cents).toBe(105_000);
  });

  it("nothing signed is 0 with no rows", () => {
    expect(bookedNotBilled({ documents: [], signedOrders: [], invoices: [] })).toEqual({ cents: 0, rows: [] });
  });
});

describe("freedomProgress", () => {
  it("is MRR over the target as a percentage, with the gap in cents", () => {
    expect(freedomProgress(125_000, 500_000)).toEqual({ targetCents: 500_000, mrrCents: 125_000, pct: 25, gapCents: 375_000 });
    expect(freedomProgress(100_000, 300_000).pct).toBe(33.3);
  });

  it("a target of 0 has no percentage and no gap", () => {
    expect(freedomProgress(50_000, 0)).toEqual({ targetCents: 0, mrrCents: 50_000, pct: null, gapCents: 0 });
    expect(freedomProgress(0, 0).pct).toBeNull();
  });

  it("MRR above the target has no gap, and the percentage can pass 100", () => {
    expect(freedomProgress(600_000, 500_000)).toEqual({ targetCents: 500_000, mrrCents: 600_000, pct: 120, gapCents: 0 });
  });

  it("no MRR is 0 percent, not null", () => {
    expect(freedomProgress(0, 500_000)).toEqual({ targetCents: 500_000, mrrCents: 0, pct: 0, gapCents: 500_000 });
  });
});
