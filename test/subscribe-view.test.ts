import { describe, expect, it } from "vitest";
import { chargeDate, checkoutError, isCheckoutUrl, pollDelay, settled, subscribeCopy, termWords, type PublicSubscription } from "../src/client/subscribeView";

const ready: PublicSubscription = { clientName: "Acme Plumbing", planName: "Care plan", monthlyCents: 29700, firstChargeOn: "2026-12-09", chargedNow: false, termMonths: 12, state: "ready" };
const text = (c: ReturnType<typeof subscribeCopy>) => [c.heading, ...c.lines, c.button ?? "", c.note].join("\n");

describe("subscribeCopy", () => {
  it("ready copy states the price, first charge date and term", () => {
    const c = subscribeCopy(ready);
    expect(c.heading).toBe("Set up your monthly payment");
    expect(c.lines).toContain("Care plan");
    expect(c.lines).toContain("$297 a month");
    expect(c.lines).toContain("First charge on December 9, 2026");
    expect(c.lines).toContain("For 12 months");
    expect(text(c)).toContain("card or bank account");
    expect(c.button).toBe("Set up payment");
  });

  it('chargedNow false reads "first charge on <date>", and true reads "charged today" whatever the date is', () => {
    expect(subscribeCopy(ready).lines.join(" ")).toMatch(/first charge on December 9, 2026/i);
    expect(subscribeCopy(ready).lines.join(" ")).not.toMatch(/charged today/i);
    // a date 1 or 2 days away is charged at Checkout: the page must not promise a later charge
    const soon = subscribeCopy({ ...ready, firstChargeOn: "2026-11-11", chargedNow: true });
    expect(soon.lines.join(" ")).toMatch(/charged today/i);
    expect(soon.lines.join(" ")).not.toMatch(/first charge on|November/i);
    const none = subscribeCopy({ ...ready, firstChargeOn: null, chargedNow: true });
    expect(none.lines.join(" ")).toMatch(/charged today/i);
    expect(none.lines.join(" ")).not.toMatch(/first charge on/i);
  });

  it("states a price with cents and a month-to-month plan", () => {
    const c = subscribeCopy({ ...ready, monthlyCents: 12950, termMonths: null });
    expect(c.lines).toContain("$129.50 a month");
    expect(c.lines).toContain("Month to month");
  });

  it("active has no button", () => {
    const c = subscribeCopy({ ...ready, state: "active" });
    expect(c.heading).toBe("You're all set");
    expect(c.button).toBeNull();
    expect(c.lines.join(" ")).toContain("Care plan");
    expect(c.lines.join(" ")).toContain("$297 a month");
    expect(c.note).not.toMatch(/receipt|email/i);
  });

  it("closed has no button and no plan details", () => {
    const c = subscribeCopy({ ...ready, state: "closed" });
    expect(c.heading).toBe("This link is no longer open");
    expect(c.button).toBeNull();
    const all = text(c);
    expect(all).not.toContain("Care plan");
    expect(all).not.toContain("297");
    expect(all).not.toContain("December");
  });

  it("no copy line contains a token or a Stripe id", () => {
    for (const state of ["ready", "active", "closed"] as const) {
      const all = text(subscribeCopy({ ...ready, state }));
      expect(all).not.toMatch(/\b(cs|sub|cus|price|prod|in|pi|evt)_[A-Za-z0-9]+/);
      expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(all).not.toMatch(/https?:/);
    }
  });
});

describe("termWords and chargeDate", () => {
  it("reads the term in plain words", () => {
    expect(termWords(12)).toBe("For 12 months");
    expect(termWords(1)).toBe("For 1 month");
    expect(termWords(null)).toBe("Month to month");
  });
  it("writes a calendar date out, and passes through one that does not read", () => {
    expect(chargeDate("2027-01-05")).toBe("January 5, 2027");
    expect(chargeDate("soon")).toBe("soon");
  });
});

describe("settled and pollDelay", () => {
  it("stops polling once the server says active or closed, and keeps going while it says ready", () => {
    expect(settled("ready")).toBe(false);
    expect(settled("active")).toBe(true);
    expect(settled("closed")).toBe(true);
  });
  it("waits a little longer each try and stops after the cap", () => {
    expect(pollDelay(0)).toBeGreaterThan(0);
    expect(pollDelay(3)!).toBeGreaterThan(pollDelay(0)!);
    expect(pollDelay(99)).toBeNull();
  });
});

describe("page helpers", () => {
  it("only follows an https stripe.com address", () => {
    expect(isCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_abc")).toBe(true);
    expect(isCheckoutUrl("http://checkout.stripe.com/x")).toBe(false);
    expect(isCheckoutUrl("https://stripe.com.evil.example/x")).toBe(false);
    expect(isCheckoutUrl("javascript:alert(1)")).toBe(false);
    expect(isCheckoutUrl(undefined)).toBe(false);
  });
  it("errors never repeat what the server sent", () => {
    for (const s of [0, 404, 409, 429, 503, 500]) expect(checkoutError(s)).toMatch(/\.$/);
  });
});

describe("public/_headers", () => {
  it("forbids framing and indexing on /s and /s/*, with the same four lines as /p", async () => {
    const text = await (await import("../public/_headers?raw")).default as string;
    const blocks = text.split(/\n(?=\S)/);
    const lines = (prefix: string) => blocks.filter((b) => b.split("\n")[0].trim() === prefix).map((b) => b.split("\n").slice(1).map((l) => l.trim()).filter(Boolean));
    expect(lines("/s")).toHaveLength(1);
    expect(lines("/s/*")).toHaveLength(1);
    expect(lines("/s")[0]).toEqual(lines("/p")[0]);
    expect(lines("/s/*")[0]).toEqual(lines("/p/*")[0]);
  });
});
