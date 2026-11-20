import { describe, expect, it } from "vitest";
import { dollars } from "../src/client/packagesView";
import {
  billingTermsProblem, billingTermsSummary, earlyExitText, groupInvoices, invoiceKindLabel, invoiceStatusLabel, isClosedInvoice, liftConfirmText, holdLine, offsetsText, parseOffsets,
  readBillingTerms, shortDate, stripeRows, subscriptionLine, subscriptionNext, WEBHOOK_EVENTS,
} from "../src/client/billingView";
import { DEFAULT_BILLING_CONFIG } from "../src/worker/billing/config";

const TODAY = "2026-12-10";
type S = Parameters<typeof invoiceStatusLabel>[0];
const inv = (o: Partial<S> & { id?: string } = {}) => ({ id: "i", status: "open", dueOn: "2026-12-20", failedOn: null, ...o }) as S & { id: string };

describe("invoiceStatusLabel", () => {
  it("a draft is not sent yet", () => {
    expect(invoiceStatusLabel(inv({ status: "draft", dueOn: null }), TODAY)).toEqual({ text: "Draft, not sent", tone: "wait" });
  });
  it("an open invoice due in the future shows its due date", () => {
    expect(invoiceStatusLabel(inv({ dueOn: "2026-12-14" }), TODAY)).toEqual({ text: "Due 14 Dec", tone: "wait" });
    expect(invoiceStatusLabel(inv({ dueOn: "2026-12-10" }), TODAY)).toEqual({ text: "Due 10 Dec", tone: "wait" });
  });
  it("an open invoice past its due date counts the days overdue", () => {
    expect(invoiceStatusLabel(inv({ dueOn: "2026-12-04" }), TODAY)).toEqual({ text: "6 days overdue", tone: "late" });
    expect(invoiceStatusLabel(inv({ dueOn: "2026-12-09" }), TODAY)).toEqual({ text: "1 day overdue", tone: "late" });
  });
  it("a failed payment says so, whatever the due date", () => {
    expect(invoiceStatusLabel(inv({ status: "failed", failedOn: "2026-12-08" }), TODAY)).toEqual({ text: "Payment failed", tone: "bad" });
  });
  it("paid, void and written-off invoices", () => {
    expect(invoiceStatusLabel(inv({ status: "paid" }), TODAY)).toEqual({ text: "Paid", tone: "ok" });
    expect(invoiceStatusLabel(inv({ status: "void" }), TODAY).text).toBe("Voided");
    expect(invoiceStatusLabel(inv({ status: "uncollectible" }), TODAY)).toEqual({ text: "Written off", tone: "bad" });
  });
  it("an open invoice with no due date is just sent", () => {
    expect(invoiceStatusLabel(inv({ dueOn: null }), TODAY)).toEqual({ text: "Sent, no due date", tone: "wait" });
  });
});

describe("groupInvoices", () => {
  it("puts drafts, overdue and failed invoices under needsYou, the rest open, and paid apart", () => {
    const rows = [
      inv({ id: "draft", status: "draft", dueOn: null }), inv({ id: "late", dueOn: "2026-12-01" }), inv({ id: "failed", status: "failed", failedOn: "2026-12-09" }),
      inv({ id: "soon", dueOn: "2026-12-30" }), inv({ id: "paid", status: "paid" }), inv({ id: "void", status: "void" }), inv({ id: "off", status: "uncollectible" }),
    ];
    const g = groupInvoices(rows, TODAY);
    expect(g.needsYou.map((r) => r.id)).toEqual(["draft", "late", "failed"]);
    expect(g.open.map((r) => r.id)).toEqual(["soon"]);
    expect(g.paid.map((r) => r.id)).toEqual(["paid"]);
    expect(rows.filter(isClosedInvoice).map((r) => r.id)).toEqual(["void", "off"]);
  });
});

describe("subscriptionLine", () => {
  const sub = { monthlyCents: 29700, termMonths: 24, termEndsOn: "2028-01-31", firstChargeOn: "2026-02-01" };
  it("reads a 24-month term with its end and first charge", () => {
    expect(subscriptionLine(sub)).toBe("$297/mo, 24-month term to 31 Jan 2028, first charge 1 Feb");
  });
  it("prints the month-end the worker clamped to", () => {
    expect(subscriptionLine({ ...sub, firstChargeOn: "2026-03-31", termEndsOn: "2028-02-29" })).toBe("$297/mo, 24-month term to 29 Feb 2028, first charge 31 Mar");
  });
  it("adds the year to the first charge when it is not this year", () => {
    expect(subscriptionLine(sub, "2027-06-01")).toBe("$297/mo, 24-month term to 31 Jan 2028, first charge 1 Feb 2026");
    expect(subscriptionLine(sub, "2026-06-01")).toBe("$297/mo, 24-month term to 31 Jan 2028, first charge 1 Feb");
  });
  it("says so when the term or the first charge is not known yet", () => {
    expect(subscriptionLine({ monthlyCents: 79700, termMonths: null, termEndsOn: null, firstChargeOn: null })).toBe("$797/mo, no fixed term, first charge date not set yet");
    expect(subscriptionLine({ ...sub, termEndsOn: null, firstChargeOn: null })).toBe("$297/mo, 24-month term, first charge date not set yet");
  });
});

describe("earlyExitText", () => {
  it("states the balance and that nothing is charged until approved", () => {
    const t = earlyExitText(118800);
    expect(t).toContain(dollars(118800));
    expect(t).toMatch(/approve/i);
  });
});

describe("subscriptionNext", () => {
  const s = (o: Record<string, unknown>) => ({ status: "planned", startsWhen: "kickoff", ...o }) as Parameters<typeof subscriptionNext>[0];
  it("offers Start billing for a kickoff subscription that has not started", () => {
    expect(subscriptionNext(s({}))).toMatchObject({ canStart: true });
    expect(subscriptionNext(s({ status: "proposed" }))).toMatchObject({ canStart: true });
    expect(subscriptionNext(s({ startsWhen: "launch" }))).toMatchObject({ canStart: false });
  });
  it("tells the link was sent, and that a live one is running", () => {
    expect(subscriptionNext(s({ status: "link_sent" })).text).toMatch(/link was sent/i);
    expect(subscriptionNext(s({ status: "active" })).canStart).toBe(false);
  });
  it("lets a live subscription be cancelled and a finished one not", () => {
    expect(subscriptionNext(s({ status: "past_due" })).canCancel).toBe(true);
    expect(subscriptionNext(s({ status: "cancelled" })).canCancel).toBe(false);
    expect(subscriptionNext(s({ status: "ended" })).canCancel).toBe(false);
  });
});

describe("holds", () => {
  it("says since when and for how long the work has been on hold", () => {
    expect(holdLine({ placedAt: "2026-12-01T18:00:00.000Z" }, TODAY, "America/Los_Angeles")).toBe("Work on hold since 1 Dec (9 days)");
  });
  it("the lift confirmation says the client has not paid", () => {
    const t = liftConfirmText("Ace Plumbing", "Milestone: design approved", 100000);
    expect(t).toContain("Ace Plumbing");
    expect(t).toContain("$1,000");
    expect(t).toMatch(/has not paid/i);
  });
});

describe("labels and helpers", () => {
  it("formats short dates and refuses a bad one", () => {
    expect(shortDate("2026-12-04")).toBe("4 Dec");
    expect(shortDate("2028-01-31", true)).toBe("31 Jan 2028");
    expect(shortDate("soon")).toBe("");
  });
  it("names every invoice kind", () => {
    expect(invoiceKindLabel("early_exit")).toBe("Early exit");
    expect(invoiceKindLabel("hourly")).toBe("Hours");
  });
});

describe("billing terms (Settings > Billing)", () => {
  it("reads the saved JSON over the defaults, and a bad document gives the defaults", () => {
    expect(readBillingTerms("")).toEqual(DEFAULT_BILLING_CONFIG);
    expect(readBillingTerms(JSON.stringify({ netDays: 14 }))).toEqual({ ...DEFAULT_BILLING_CONFIG, netDays: 14 });
    expect(readBillingTerms("{nope")).toEqual(DEFAULT_BILLING_CONFIG);
  });
  it("reads the reminder days typed in a box", () => {
    expect(parseOffsets("-3, 0, 3, 7")).toEqual([-3, 0, 3, 7]);
    expect(parseOffsets("3 7")).toEqual([3, 7]);
    expect(parseOffsets("")).toBeNull();
    expect(parseOffsets("3, soon")).toBeNull();
    expect(parseOffsets("1.5")).toBeNull();
    expect(offsetsText([-3, 0, 3, 7])).toBe("-3, 0, 3, 7");
  });
  it("accepts the defaults and names the field when a number is out of range or out of order", () => {
    expect(billingTermsProblem(DEFAULT_BILLING_CONFIG)).toBeNull();
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, netDays: 0 })).toMatch(/Days to pay/);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, netDays: 61 })).toMatch(/Days to pay/);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, reminderOffsets: [3, 0] })).toMatch(/order/);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, reminderOffsets: [0, 3], pauseAfterDays: 7 })).toBeNull();
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, reminderOffsets: [0, 10], pauseAfterDays: 10 })).toMatch(/after the last reminder/);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, pauseAfterDays: 6 })).toMatch(/Pause/);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, termNoticeDays: 91 })).toMatch(/notice/i);
    expect(billingTermsProblem({ ...DEFAULT_BILLING_CONFIG, netDays: 7.5 })).toMatch(/whole/);
  });
  it("summarises the terms for the settings overview", () => {
    expect(billingTermsSummary("")).toEqual({ tone: "", text: "Net 7 days, pause after 14" });
  });
});

describe("Stripe status panel", () => {
  it("lists the seven events the webhook handles", () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual([
      "checkout.session.completed", "customer.subscription.deleted", "customer.subscription.updated", "invoice.marked_uncollectible", "invoice.paid", "invoice.payment_failed", "invoice.voided",
    ]);
  });
  it("shows booleans and a mode, never a key", () => {
    const rows = stripeRows({ mode: "test", webhookSecretSet: true, clientBaseSet: false, legalReviewed: false });
    expect(rows.map((r) => [r.label, r.ok])).toEqual([["Stripe key", true], ["Webhook secret", true], ["Client link base", false], ["Lawyer review recorded", false]]);
    expect(rows[0].text).toBe("Test mode");
    expect(stripeRows({ mode: null, webhookSecretSet: false, clientBaseSet: false, legalReviewed: false })[0]).toMatchObject({ ok: false, text: "Not set up" });
    expect(stripeRows({ mode: "live", webhookSecretSet: true, clientBaseSet: true, legalReviewed: true })[0].text).toBe("Live mode");
  });
});
