import { describe, expect, it } from "vitest";
import type { PackageKey, PackageSnapshot } from "../src/worker/db/packages";
import { optionTotals, type Option } from "../src/worker/sales/options";
import { ScheduleError, paymentSchedule } from "../src/worker/documents/schedule";

const S = (key: PackageKey, name: string, kind: PackageSnapshot["kind"], priceCents: number, o: Partial<PackageSnapshot> = {}): PackageSnapshot =>
  ({ key, version: 1, name, kind, priceCents, setupCents: 0, termMonths: null, fromPrice: false, ...o });
const SNAP: PackageSnapshot[] = [
  S("quick_fix", "Quick Fix", "one_time", 79700),
  S("starter_site", "Starter Site", "one_time", 399700, { fromPrice: true }),
  S("growth_site", "Growth Site", "one_time", 699700, { fromPrice: true }),
  S("website_subscription", "Website Subscription", "subscription", 29700, { setupCents: 49700, termMonths: 24 }),
  S("care", "Care", "monthly", 12900),
  S("care_plus", "Care Plus", "monthly", 24900),
  S("client_hosted_surcharge", "Client-hosted surcharge", "monthly", 3000),
  S("local_seo", "Local SEO", "monthly", 79700, { setupCents: 75000, termMonths: 6 }),
  S("local_seo_growth", "Local SEO Growth", "monthly", 149700),
  S("reviews_addon", "Reviews add-on", "monthly", 9900),
  S("hourly", "Hourly", "hourly", 12500),
];
const opt = (items: Option["items"]): Option => ({ id: "b", label: "L", tagline: "t", items, recommended: true });
const sched = (items: Option["items"]) => paymentSchedule(opt(items), SNAP);
const amounts = (items: Option["items"]) => sched(items).milestones.map((m) => [m.dueOn, m.amountCents]);

describe("payment schedule", () => {
  it("quick fix is 100% at signing", () => {
    const s = sched([{ key: "quick_fix" }]);
    expect(s.milestones).toEqual([{ id: "signing", label: "Deposit at signing", dueOn: "signing", amountCents: 79700 }]);
    expect(s.recurring).toEqual([]);
    expect(s.depositCents).toBe(79700);
  });

  it("starter splits 50/50 and ends when the site is finished", () => {
    expect(amounts([{ key: "starter_site" }])).toEqual([["signing", 199850], ["site_finished", 199850]]);
    expect(sched([{ key: "starter_site" }]).depositCents).toBe(199850);
  });

  it("growth is 40/30/30 and the remainder lands on the last milestone", () => {
    expect(amounts([{ key: "growth_site" }])).toEqual([["signing", 279880], ["design_approved", 209910], ["site_finished", 209910]]);
    // $1,000.01 does not split cleanly: each share rounds down and the odd cent lands on the last milestone.
    const odd = paymentSchedule(opt([{ key: "growth_site" }]), [S("growth_site", "Growth Site", "one_time", 100001)]);
    expect(odd.milestones.map((m) => m.amountCents)).toEqual([40000, 30000, 30001]);
  });

  it("a setup discount lowers the amount before the split", () => {
    expect(amounts([{ key: "starter_site", setupDiscountCents: 100000 }])).toEqual([["signing", 149850], ["site_finished", 149850]]);
    const s = sched([{ key: "website_subscription", setupDiscountCents: 20000 }, { key: "care" }]);
    expect(s.milestones.map((m) => m.amountCents)).toEqual([29700]);
  });

  it("subscription bills only the setup at signing and the monthly from launch", () => {
    const s = sched([{ key: "website_subscription" }]);
    expect(s.milestones).toEqual([{ id: "signing", label: "Deposit at signing", dueOn: "signing", amountCents: 49700 }]);
    expect(s.recurring).toEqual([{ key: "website_subscription", name: "Website Subscription", monthlyCents: 29700, startsOn: "launch", termMonths: 24, firstMonthPrepaid: false }]);
    expect(s.depositCents).toBe(49700);
  });

  it("local seo bills the 75000 setup at signing and monthly from kickoff", () => {
    const s = sched([{ key: "local_seo" }]);
    expect(s.milestones.map((m) => [m.dueOn, m.amountCents])).toEqual([["signing", 75000]]);
    expect(s.recurring).toEqual([{ key: "local_seo", name: "Local SEO", monthlyCents: 79700, startsOn: "kickoff", termMonths: 6, firstMonthPrepaid: false }]);
    expect(s.depositCents).toBe(75000);
  });

  it("care alone prepays the first month at signing", () => {
    const s = sched([{ key: "care" }]);
    expect(s.milestones).toEqual([]);
    expect(s.recurring).toEqual([{ key: "care", name: "Care", monthlyCents: 12900, startsOn: "signing", termMonths: null, firstMonthPrepaid: true }]);
    expect(s.depositCents).toBe(12900);
  });

  it("care with a build starts at launch and is not prepaid", () => {
    const s = sched([{ key: "starter_site" }, { key: "care_plus" }, { key: "client_hosted_surcharge" }]);
    expect(s.recurring.map((r) => [r.key, r.startsOn, r.firstMonthPrepaid])).toEqual([["care_plus", "launch", false], ["client_hosted_surcharge", "launch", false]]);
    expect(s.depositCents).toBe(199850);
  });

  it("a monthly item with no setup of its own prepays its first month, so a deposit always exists", () => {
    const s = sched([{ key: "local_seo_growth" }]);
    expect(s.recurring[0]).toMatchObject({ startsOn: "kickoff", firstMonthPrepaid: true });
    expect(s.depositCents).toBe(149700);
    const free = sched([{ key: "local_seo", setupDiscountCents: 75000 }]);
    expect(free.milestones).toEqual([]);
    expect(free.recurring[0]).toMatchObject({ startsOn: "kickoff", firstMonthPrepaid: true });
    expect(free.depositCents).toBe(79700);
  });

  it("amounts due at the same moment add up into one milestone", () => {
    const s = sched([{ key: "quick_fix" }, { key: "local_seo" }]);
    expect(s.milestones.map((m) => [m.id, m.amountCents])).toEqual([["signing", 154700]]);
  });

  it("hourly is a rate, not a charge", () => {
    const s = sched([{ key: "quick_fix" }, { key: "hourly" }]);
    expect(s.recurring).toEqual([]);
    expect(s.depositCents).toBe(79700);
  });

  it("an item missing from the snapshot throws", () => {
    expect(() => paymentSchedule(opt([{ key: "quick_fix" }, { key: "care" }]), SNAP.filter((p) => p.key !== "care"))).toThrow(ScheduleError);
  });

  it("a deposit of zero throws", () => {
    expect(() => sched([{ key: "quick_fix", setupDiscountCents: 79700 }])).toThrow(/deposit/i);
  });

  it("a discount larger than what it discounts throws", () => {
    expect(() => sched([{ key: "starter_site", setupDiscountCents: 500000 }])).toThrow(ScheduleError);
    expect(() => sched([{ key: "quick_fix", setupDiscountCents: 1.5 }])).toThrow(ScheduleError);
  });

  it("milestones plus discounts always equal optionTotals upfront", () => {
    const fixtures: Option["items"][] = [
      [{ key: "quick_fix" }], [{ key: "quick_fix" }, { key: "care" }], [{ key: "quick_fix", setupDiscountCents: 10000 }, { key: "local_seo" }],
      [{ key: "starter_site" }, { key: "care" }], [{ key: "starter_site", setupDiscountCents: 99700 }, { key: "care_plus" }, { key: "client_hosted_surcharge" }],
      [{ key: "growth_site" }, { key: "care" }, { key: "reviews_addon" }], [{ key: "growth_site", setupDiscountCents: 1 }],
      [{ key: "website_subscription" }], [{ key: "website_subscription", setupDiscountCents: 49700 }, { key: "care" }],
      [{ key: "local_seo" }, { key: "reviews_addon" }], [{ key: "local_seo", setupDiscountCents: 25000 }], [{ key: "local_seo_growth" }],
      [{ key: "care" }], [{ key: "care_plus" }, { key: "hourly" }], [{ key: "quick_fix" }, { key: "local_seo_growth" }],
    ];
    for (const items of fixtures) {
      const o = opt(items);
      const s = paymentSchedule(o, SNAP);
      const upfront = optionTotals(o, SNAP).upfrontCents;
      const discounts = items.reduce((n, i) => n + (i.setupDiscountCents ?? 0), 0);
      const gross = items.reduce((n, i) => {
        const p = SNAP.find((x) => x.key === i.key)!;
        return n + (p.kind === "one_time" ? p.priceCents : 0) + p.setupCents;
      }, 0);
      const sum = s.milestones.reduce((n, m) => n + m.amountCents, 0);
      expect(sum, JSON.stringify(items)).toBe(upfront);
      expect(sum + discounts, JSON.stringify(items)).toBe(gross);
      expect(s.depositCents).toBeGreaterThan(0);
      expect(Number.isInteger(s.depositCents)).toBe(true);
    }
  });
});
