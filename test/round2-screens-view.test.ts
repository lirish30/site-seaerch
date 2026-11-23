import { describe, expect, it } from "vitest";
import { invoiceSteps } from "../src/client/billingView";
import { capShare } from "../src/client/moneyView";
import { bucketTone } from "../src/client/approvalsInbox";

const inv = (o: Record<string, unknown>) => ({ status: "open", createdAt: "2026-11-01T10:00:00Z", sentAt: "2026-11-01T17:00:00Z", dueOn: "2026-11-08", failedOn: null, paidAt: null, ...o }) as Parameters<typeof invoiceSteps>[0];

describe("invoiceSteps", () => {
  it("marks every step done on a paid invoice", () => {
    const s = invoiceSteps(inv({ status: "paid", paidAt: "2026-11-02T19:00:00Z" }), "2026-11-22");
    expect(s.map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    expect(s[3].when).toBe("2 Nov");
  });
  it("puts a draft's send step on you", () => {
    const s = invoiceSteps(inv({ status: "draft", sentAt: null, dueOn: null }), "2026-11-22");
    expect(s.map((x) => x.key)).toEqual(["made", "sent", "paid"]);
    expect(s[1]).toMatchObject({ state: "now", when: "Waits for your OK" });
  });
  it("marks a late invoice's due step bad with the days", () => {
    const s = invoiceSteps(inv({}), "2026-11-12");
    expect(s[2]).toMatchObject({ state: "bad", when: "8 Nov, 4 days late" });
    expect(s[3].state).toBe("todo");
  });
  it("ends a voided one", () => {
    expect(invoiceSteps(inv({ status: "void" }), "2026-11-05").at(-1)).toMatchObject({ label: "Voided", state: "bad" });
  });
});

describe("capShare", () => {
  it("says a few cents is under 1%", () => expect(capShare(0.04, 150)).toBe("Under 1% of the cap"));
  it("rounds a share", () => expect(capShare(52.4, 150)).toBe("35% of the cap"));
  it("handles no cap and a reached cap", () => { expect(capShare(1, 0)).toBe("No cap set"); expect(capShare(15, 15)).toBe("At or over the cap"); });
  it("says 0% when nothing is spent", () => expect(capShare(0, 15)).toBe("0% of the cap"));
});

describe("bucketTone", () => {
  it("tints money green and mail blue", () => { expect(bucketTone("invoices")).toBe("positive"); expect(bucketTone("emails")).toBe("info"); expect(bucketTone("other")).toBe("neutral"); });
});
