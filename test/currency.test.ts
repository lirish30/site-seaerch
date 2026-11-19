import { describe, expect, it } from "vitest";
import { CURRENCY, figuresIn, refuseCurrency, refuseCurrencyIn } from "../src/worker/sales/currency";

describe("refuseCurrency", () => {
  const none = new Set<string>();

  it("refuses every way of writing an amount when nothing is allowed", () => {
    for (const t of ["It is $500.", "Just $ 500 today", "about $1,200 a year", "500 dollars", "5 Dollars a month", "1,200 USD", "300usd", "USD 750", "usd750", "dollars 40", "$4.50", "$5k", "500.dollars"]) {
      expect(refuseCurrency([t], none), t).toMatch(/price/);
      expect(CURRENCY.test(t), t).toBe(true);
    }
  });

  it("lets plain numbers and words through", () => {
    for (const t of ["Five calls a month", "Up to 5 pages", "A 24 month term", "30 minutes", "the dollar sign key", "Paid 40/30/30", "2026", "Called him 3 times"]) {
      expect(refuseCurrency([t], none), t).toBeNull();
    }
    expect(refuseCurrency([], none)).toBeNull();
  });

  it("allows an amount only when its digits are in the allowed set, commas and a zero cents tail ignored", () => {
    const owner = new Set(["400", "4500"]);
    expect(refuseCurrency(["A job is worth $400."], owner)).toBeNull();
    expect(refuseCurrency(["A job is worth $4,500.00"], owner)).toBeNull();
    expect(refuseCurrency(["4500 dollars a job", "USD 400"], owner)).toBeNull();
    expect(refuseCurrency(["A job is worth $401."], owner)).toMatch(/\$401/);
    expect(refuseCurrency(["$400 a job, and $800 for our fix"], owner)).toMatch(/\$800/); // one allowed amount does not excuse another
  });

  it("checks every text and names the amount", () => {
    expect(refuseCurrency(["fine", "also fine", "costs $99"], none)).toBe("it has a price ($99) that is not a number the owner gave");
  });
});

describe("figuresIn", () => {
  it("takes the figures out of typed text, commas removed", () => {
    expect([...figuresIn(["About $400 a job", "we miss 5 a month, maybe 1,200 a year", "none here"])].sort()).toEqual(["1200", "400", "5"]);
    expect(figuresIn([]).size).toBe(0);
  });
});

describe("refuseCurrencyIn", () => {
  it("starts the reason with the first field that has a price", () => {
    expect(refuseCurrencyIn({ opener: "hello", "pushback 2 answer": "only $50" }, new Set())).toBe("pushback 2 answer: it has a price ($50) that is not a number the owner gave");
    expect(refuseCurrencyIn({ goals: ["a", "b $60"] }, new Set(["60"]))).toBeNull();
    expect(refuseCurrencyIn({}, new Set())).toBeNull();
  });
});
