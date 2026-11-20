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

  it("the onboarding kinds read as the onboarding", () => {
    const titles = {
      onboarding_started: "Onboarding started", onboarding_welcome: "Welcome sent", onboarding_submitted: "Questionnaire submitted",
      onboarding_received: "Client sent materials", onboarding_waiting: "Waiting on the client", onboarding_resumed: "Client is back",
    } as const;
    for (const [kind, title] of Object.entries(titles)) expect(describeActivity({ kind: kind as keyof typeof titles, detail: null }).title, kind).toBe(title);
    expect(describeActivity({ kind: "onboarding_waiting", detail: "10 days without a word" })).toMatchObject({ tone: "warning", detail: "10 days without a word" });
  });

  it("the project and change-order kinds read as such", () => {
    const titles = {
      project_started: "Project started", project_milestone: "Project milestone", project_done: "Project finished",
      change_order_sent: "Change order sent", change_order_signed: "Change order signed", change_order_paid: "Change order paid", change_order_void: "Change order voided", change_order_declined: "Change order declined", invoice_sent: "Invoice sent", invoice_paid: "Invoice paid", billing_hold_placed: "Work paused: invoice overdue",
    } as const;
    for (const [kind, title] of Object.entries(titles)) expect(describeActivity({ kind: kind as keyof typeof titles, detail: null }).title, kind).toBe(title);
    expect(describeActivity({ kind: "change_order_void", detail: "client changed their mind" })).toMatchObject({ tone: "warning", detail: "client changed their mind" });
    // The daily sweep's line reads as an expiry; an owner's void keeps its title, even when the reason is the word "expired".
    expect(describeActivity({ kind: "change_order_void", detail: "SL-ABC-CO1 (1a2b3c4d): expired" })).toMatchObject({ title: "Change order expired", detail: "SL-ABC-CO1 (1a2b3c4d): expired" });
    expect(describeActivity({ kind: "change_order_void", detail: "SL-ABC-CO1 (1a2b3c4d) voided: expired" }).title).toBe("Change order voided");
    expect(describeActivity({ kind: "project_milestone", detail: "design_approved" }).detail).toBe("design_approved");
  });

  it("the site and access kinds read as such, with no more than the server logged", () => {
    expect(describeActivity({ kind: "site_added", detail: "Site added: example.com" })).toMatchObject({ title: "Site added", detail: "example.com" });
    expect(describeActivity({ kind: "site_added", detail: "Site added: no domain yet" })).toMatchObject({ title: "Site added", detail: "no domain yet" });
    expect(describeActivity({ kind: "site_changed", detail: "Site updated: address, host" })).toMatchObject({ title: "Site changed", detail: "address, host" });
    expect(describeActivity({ kind: "site_changed", detail: "Site archived" })).toMatchObject({ title: "Site archived", detail: null });
    expect(describeActivity({ kind: "access_changed", detail: "Hosting: requested" })).toMatchObject({ title: "Access changed", detail: "Hosting: requested" });
    expect(describeActivity({ kind: "access_changed", detail: "DNS: details updated" }).detail).toBe("DNS: details updated");
  });
});
