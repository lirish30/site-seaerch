import { describe, it, expect } from "vitest";
import type { Package, PackageKey } from "../src/worker/db/packages";
import { optionTotals, validateOptions, type Option } from "../src/worker/sales/options";

const pkg = (key: PackageKey, p: Partial<Package> = {}): Package => ({
  id: key, key, version: 1, name: key, kind: "monthly", priceCents: 0, setupCents: 0, termMonths: null, altPriceCents: null, fromPrice: false,
  summary: "", includes: [], wordpressOnly: false, publicOffer: true, active: true, createdAt: "2026-11-18T00:00:00.000Z", ...p,
});
const catalog: Package[] = [
  pkg("quick_fix", { kind: "one_time", priceCents: 79700 }),
  pkg("starter_site", { kind: "one_time", priceCents: 399700, fromPrice: true }),
  pkg("website_subscription", { kind: "subscription", priceCents: 29700, setupCents: 49700, termMonths: 24 }),
  pkg("care", { priceCents: 12900, wordpressOnly: true }),
  pkg("care_plus", { priceCents: 24900, wordpressOnly: true }),
  pkg("care_fallback", { priceCents: 7900, publicOffer: false }),
  pkg("local_seo", { priceCents: 79700, setupCents: 75000, termMonths: 6 }),
];
const opt = (id: Option["id"], items: Option["items"], recommended = false): Option => ({ id, label: `Option ${id}`, tagline: "", items, recommended });
const good = (): Option[] => [
  opt("a", [{ key: "quick_fix" }]),
  opt("b", [{ key: "starter_site" }, { key: "care" }], true),
  opt("c", [{ key: "website_subscription" }]),
];
const ctx = { platform: "wordpress" as const, catalog };

describe("optionTotals", () => {
  it("adds setup and monthly separately", () => {
    expect(optionTotals(opt("a", [{ key: "quick_fix" }, { key: "care" }]), catalog)).toEqual({ upfrontCents: 79700, monthlyCents: 12900 });
    expect(optionTotals(opt("a", [{ key: "website_subscription" }, { key: "local_seo" }]), catalog)).toEqual({ upfrontCents: 49700 + 75000, monthlyCents: 29700 + 79700 });
  });
  it("takes setup discounts off the upfront total only", () => {
    const o = opt("a", [{ key: "website_subscription", setupDiscountCents: 10000 }]);
    expect(optionTotals(o, catalog)).toEqual({ upfrontCents: 39700, monthlyCents: 29700 });
  });
});

describe("validateOptions", () => {
  it("accepts a well-formed set", () => {
    expect(validateOptions(good(), ctx)).toEqual([]);
  });
  it("needs exactly three options", () => {
    expect(validateOptions(good().slice(0, 2), ctx).join(" ")).toMatch(/three options/i);
  });
  it("discount on a monthly price is refused", () => {
    const o = good(); o[1] = opt("b", [{ key: "starter_site" }, { key: "care", setupDiscountCents: 1000 }], true);
    expect(validateOptions(o, ctx).join(" ")).toMatch(/setup/i);
  });
  it("discount above the setup fee is refused", () => {
    const o = good(); o[2] = opt("c", [{ key: "website_subscription", setupDiscountCents: 49701 }]);
    expect(validateOptions(o, ctx).join(" ")).toMatch(/more than/i);
    const ok = good(); ok[2] = opt("c", [{ key: "website_subscription", setupDiscountCents: 49700 }]);
    expect(validateOptions(ok, ctx)).toEqual([]);
  });
  it("care on an other-platform site is refused", () => {
    expect(validateOptions(good(), { ...ctx, platform: "other" }).join(" ")).toMatch(/WordPress/);
  });
  it("care and care_plus together are refused", () => {
    const o = good(); o[1] = opt("b", [{ key: "starter_site" }, { key: "care" }, { key: "care_plus" }], true);
    expect(validateOptions(o, ctx).join(" ")).toMatch(/one Care plan/i);
  });
  it("recommended must be the middle option", () => {
    const o = good(); o[0].recommended = true; o[1].recommended = false;
    expect(validateOptions(o, ctx).join(" ")).toMatch(/middle/i);
    const none = good().map((x) => ({ ...x, recommended: false }));
    expect(validateOptions(none, ctx).join(" ")).toMatch(/recommended/i);
    const two = good(); two[0].recommended = true;
    expect(validateOptions(two, ctx).join(" ")).toMatch(/exactly one/i);
  });
  it("care_fallback is refused as a public offer", () => {
    const o = good(); o[1] = opt("b", [{ key: "starter_site" }, { key: "care_fallback" }], true);
    expect(validateOptions(o, ctx).join(" ")).toMatch(/not offered/i);
  });
  it("refuses an unknown or inactive package", () => {
    const o = good(); o[0] = opt("a", [{ key: "hourly" }]);
    expect(validateOptions(o, ctx).join(" ")).toMatch(/not in the catalog/i);
    const off = catalog.map((p) => (p.key === "quick_fix" ? { ...p, active: false } : p));
    expect(validateOptions(good(), { ...ctx, catalog: off }).join(" ")).toMatch(/not active/i);
  });
});
