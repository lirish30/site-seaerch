import { describe, it, expect } from "vitest";
import { describeActivity, filterOf } from "../src/client/activityView";
import { ACTIVITY_KINDS } from "../src/worker/types";

describe("activityView", () => {
  it("every activity kind has a non-empty label", () => {
    for (const kind of ACTIVITY_KINDS) {
      const d = describeActivity({ kind, detail: null });
      expect(d.title.trim(), kind).not.toBe("");
      expect(d.icon, kind).toBeTruthy();
    }
  });

  it("the proposal kinds read as the proposal and the deposit", () => {
    const titles = { proposal_sent: "Proposal sent", proposal_viewed: "Proposal viewed", proposal_signed: "Proposal signed", proposal_void: "Proposal voided", deposit_paid: "Deposit paid" } as const;
    for (const [kind, title] of Object.entries(titles)) expect(describeActivity({ kind: kind as keyof typeof titles, detail: null }).title).toBe(title);
    expect(describeActivity({ kind: "proposal_void", detail: "re-scoped" })).toMatchObject({ tone: "warning", detail: "re-scoped" });
    // The daily sweep's line reads as an expiry, not as something the owner voided.
    expect(describeActivity({ kind: "proposal_void", detail: "SL-ABCDEF v1: expired" })).toMatchObject({ title: "Proposal expired", tone: "warning", detail: "SL-ABCDEF v1: expired" });
  });

  it("the mail kinds have their own labels and sit under Emails", () => {
    expect(describeActivity({ kind: "email_sent", detail: "Quick video" })).toMatchObject({ title: "Email sent", detail: "Quick video" });
    expect(describeActivity({ kind: "email_reply", detail: null }).title).toBe("Reply received");
    expect(describeActivity({ kind: "email_bounce", detail: null })).toMatchObject({ title: "Email bounced", tone: "critical" });
    for (const k of ["email_sent", "email_reply", "email_bounce"]) expect(filterOf(k)).toBe("emails");
  });
});
