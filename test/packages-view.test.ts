import { describe, it, expect } from "vitest";
import type { Package } from "../src/worker/db/packages";
import { formatPrice, parseDollars, priceWarnings } from "../src/client/packagesView";

const pkg = (p: Partial<Package>): Package => ({
  id: "x", key: "quick_fix", version: 1, name: "X", kind: "one_time", priceCents: 79700, setupCents: 0, termMonths: null, altPriceCents: null,
  fromPrice: false, summary: "", includes: [], wordpressOnly: false, publicOffer: true, active: true, createdAt: "2026-11-18T00:00:00.000Z", ...p,
});

describe("formatPrice", () => {
  it("formats a one-time price, a from price and a subscription", () => {
    expect(formatPrice(pkg({}))).toBe("$797");
    expect(formatPrice(pkg({ priceCents: 399700, fromPrice: true }))).toBe("from $3,997");
    expect(formatPrice(pkg({ kind: "subscription", priceCents: 29700, setupCents: 49700, termMonths: 24 }))).toBe("$297/mo for 24 months + $497 setup");
  });
  it("formats monthly and hourly prices", () => {
    expect(formatPrice(pkg({ kind: "monthly", priceCents: 12900 }))).toBe("$129/mo");
    expect(formatPrice(pkg({ kind: "monthly", priceCents: 79700, setupCents: 75000, termMonths: 6 }))).toBe("$797/mo + $750 setup, 6-month first term");
    expect(formatPrice(pkg({ kind: "hourly", priceCents: 12500, altPriceCents: 9500 }))).toBe("$125/hr ($95 for Care clients)");
  });
});

describe("priceWarnings", () => {
  it("warns when a price rises more than 25% or falls, and is quiet for a small rise", () => {
    expect(priceWarnings(pkg({}), pkg({ priceCents: 119700 }))[0]).toMatch(/rises 50%/);
    expect(priceWarnings(pkg({}), pkg({ priceCents: 59700 }))[0]).toMatch(/falls 25%/);
    expect(priceWarnings(pkg({}), pkg({ priceCents: 89700 }))).toEqual([]);
    expect(priceWarnings(pkg({}), pkg({}))).toEqual([]);
  });
});

describe("parseDollars", () => {
  it("turns a dollar box into whole cents, or null", () => {
    expect(parseDollars("$1,297")).toBe(129700);
    expect(parseDollars("797.50")).toBe(79750);
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
  });
});
