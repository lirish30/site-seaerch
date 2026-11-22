import { describe, expect, it } from "vitest";
import { chartScale, clientsToGoal, fmtUsd2, monthTitle } from "../src/client/moneyView";
import { invoiceChip, invoiceSeg, pauseOn, pendingReminder, reminderNote, remindersFrom } from "../src/client/billingView";

const inv = (o: Partial<{ id: string; status: "draft" | "open" | "paid" | "void" | "uncollectible" | "failed"; dueOn: string | null; failedOn: string | null; paidAt: string | null }>) =>
  ({ id: "i1", status: "open" as const, dueOn: "2026-11-15", failedOn: null, paidAt: null, ...o });
const terms = { reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14 };

describe("money dashboard helpers", () => {
  it("always shows cents in table money", () => {
    expect(fmtUsd2(279880)).toBe("$2,798.80");
    expect(fmtUsd2(0)).toBe("$0.00");
    expect(fmtUsd2(-1200)).toBe("-$12.00");
  });
  it("names the month in the booking zone", () => {
    expect(monthTitle("2026-12-01T05:00:00Z", "America/Los_Angeles")).toBe("November 2026");
  });
  it("scales bars to the larger of the top month and the goal", () => {
    expect(chartScale([0, 250, 500], 1000)).toEqual({ bars: [0, 25, 50], goalPct: 100 });
    expect(chartScale([0, 2000], 1000)).toEqual({ bars: [0, 100], goalPct: 50 });
    expect(chartScale([0, 0], 0)).toEqual({ bars: [0, 0], goalPct: null });
  });
  it("counts the clients to the goal at today's average", () => {
    expect(clientsToGoal(173000, 7, 327000)).toBe(14);
    expect(clientsToGoal(0, 0, 100)).toBeNull();
    expect(clientsToGoal(1000, 2, 0)).toBeNull();
  });
});

describe("invoices table helpers", () => {
  const today = "2026-11-22";
  it("sorts invoices into the filter tabs", () => {
    expect(invoiceSeg(inv({ status: "draft" }), today)).toBe("drafts");
    expect(invoiceSeg(inv({ dueOn: "2026-11-29" }), today)).toBe("sent");
    expect(invoiceSeg(inv({}), today)).toBe("overdue");
    expect(invoiceSeg(inv({ status: "failed" }), today)).toBe("overdue");
    expect(invoiceSeg(inv({ status: "paid" }), today)).toBe("paid");
    expect(invoiceSeg(inv({ status: "void" }), today)).toBe("closed");
  });
  it("gives the short status chip", () => {
    expect(invoiceChip(inv({}), today)).toEqual({ text: "7 days late", tone: "critical", dot: true });
    expect(invoiceChip(inv({ dueOn: "2026-11-29" }), today).text).toBe("Sent");
    expect(invoiceChip(inv({ status: "draft" }), today)).toEqual({ text: "Draft", tone: "neutral", dot: false });
  });
  it("counts the pause day from the due date, or the failed day", () => {
    expect(pauseOn(inv({}), terms)).toBe("2026-11-29");
    expect(pauseOn(inv({ failedOn: "2026-11-20" }), terms)).toBe("2026-12-04");
    expect(pauseOn(inv({ dueOn: null }), terms)).toBeNull();
  });
  it("reads reminders from the approvals list and says where they stand", () => {
    const r = remindersFrom([
      { kind: "invoice.reminder", status: "approved", payload: { invoiceId: "i1", step: 1 } },
      { kind: "invoice.reminder", status: "pending", payload: { invoiceId: "i1", step: 2 } },
      { kind: "invoice.send", status: "pending", payload: { invoiceId: "i1" } },
      { kind: "invoice.reminder", status: "pending", payload: null },
    ]);
    expect(r).toHaveLength(2);
    expect(pendingReminder("i1", r)?.step).toBe(2);
    expect(reminderNote(inv({}), today, terms, r)).toBe("Reminder 2 waiting for you");
    expect(reminderNote(inv({}), today, terms, r.filter((x) => x.status === "approved"))).toBe("1 sent, next 22 Nov");
    expect(reminderNote(inv({ dueOn: "2026-11-29" }), today, terms, [])).toBe("Next on 26 Nov");
    expect(reminderNote(inv({ dueOn: "2026-10-01" }), today, terms, [])).toBe("All reminders raised");
    expect(reminderNote(inv({ status: "draft" }), today, terms, [])).toBe("Not sent yet");
    expect(reminderNote(inv({ status: "paid", paidAt: "2026-11-03T19:00:00Z" }), today, terms, [])).toBe("Paid 3 Nov");
  });
});
