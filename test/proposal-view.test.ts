import { describe, expect, it } from "vitest";
import { contactOf, depositLine, editsOf, formOf, isProposalDirty, proposalSteps, sendBlockers } from "../src/client/proposalView";
import { DEFAULT_ASSUMPTIONS, DEFAULT_OUT_OF_SCOPE } from "../src/worker/documents/proposal";
import type { Document } from "../src/worker/db/documents";
import { proposal } from "./fixtures/documents";

const doc = (o: Partial<Document> = {}): Document => ({
  id: "d1", dealId: "deal", businessId: "biz", version: 1, status: "draft", test: false, optionId: "b", content: proposal(), contentSha256: null, token: null,
  sentAt: null, expiresAt: null, firstViewedAt: null, signedAt: null, paidAt: null, voidReason: null, pdfKey: null, pdfSha256: null, pdfError: null, approvalId: null,
  createdAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-12-01T00:00:00.000Z", ...o,
});

describe("proposalSteps", () => {
  it("a draft has only the first step done", () => {
    expect(proposalSteps(doc()).map((s) => [s.label, s.done])).toEqual([["Drafted", true], ["Sent", false], ["Viewed", false], ["Signed", false], ["Deposit paid", false]]);
  });
  it("each step carries its time and is done once it has one", () => {
    const steps = proposalSteps(doc({ status: "viewed", sentAt: "2026-12-01T17:00:00.000Z", firstViewedAt: "2026-12-02T09:00:00.000Z", expiresAt: "2026-12-31T17:00:00.000Z" }));
    expect(steps.map((s) => [s.label, s.at, s.done])).toEqual([
      ["Drafted", "2026-12-01T00:00:00.000Z", true], ["Sent", "2026-12-01T17:00:00.000Z", true], ["Viewed", "2026-12-02T09:00:00.000Z", true], ["Signed", null, false], ["Deposit paid", null, false],
    ]);
  });
  it("the Viewed step carries the view count", () => {
    const viewed = doc({ status: "viewed", sentAt: "2026-12-01T17:00:00.000Z", firstViewedAt: "2026-12-02T09:00:00.000Z" });
    expect(proposalSteps(viewed, 1)[2]).toEqual({ label: "Viewed 1 time", at: "2026-12-02T09:00:00.000Z", done: true });
    expect(proposalSteps(viewed, 3)[2].label).toBe("Viewed 3 times");
    expect(proposalSteps(viewed)[2].label).toBe("Viewed");
    expect(proposalSteps(doc(), 0)[2]).toMatchObject({ label: "Viewed", done: false });
  });
  it("proposalSteps shows void in place of the later steps", () => {
    const steps = proposalSteps(doc({ status: "void", voidReason: "wrong option", sentAt: "2026-12-01T17:00:00.000Z" }));
    expect(steps.map((s) => s.label)).toEqual(["Drafted", "Sent", "Voided: wrong option"]);
    expect(steps[2]).toMatchObject({ done: true });
  });
  it("an expired document ends in one expired line", () => {
    const steps = proposalSteps(doc({ status: "expired", sentAt: "2026-12-01T17:00:00.000Z", expiresAt: "2026-12-31T17:00:00.000Z" }));
    expect(steps.map((s) => s.label)).toEqual(["Drafted", "Sent", "Expired"]);
    expect(steps[2].at).toBe("2026-12-31T17:00:00.000Z");
  });
  it("a draft that was voided before it was sent has no Sent step", () => {
    expect(proposalSteps(doc({ status: "void", voidReason: "x" })).map((s) => s.label)).toEqual(["Drafted", "Voided: x"]);
  });
});

describe("sendBlockers", () => {
  const ok = { legalGate: null, clientBase: "https://clients.example.com", doc: doc() };
  it("a draft with the review recorded and a client base has none", () => {
    expect(sendBlockers(ok)).toEqual([]);
  });
  it("sendBlockers lists the legal gate and a missing client base", () => {
    const b = sendBlockers({ legalGate: "Have an Oregon lawyer review the clauses.", clientBase: null, doc: doc() });
    expect(b).toEqual(["Have an Oregon lawyer review the clauses.", "Set CLIENT_LINK_BASE (an https address for client links) before sending."]);
  });
  it("a document that is not a draft, and a test document, cannot go for approval", () => {
    expect(sendBlockers({ ...ok, doc: doc({ status: "sent" }) })).toEqual(["Only a draft can be sent. Void this version to start a new one."]);
    expect(sendBlockers({ ...ok, doc: doc({ test: true }) })).toEqual(["This is a test copy. Void it and make a new draft to send for real."]);
  });
});

describe("the proposal form", () => {
  const defaults = { recommendedOptionId: "b" as const, contact: { name: "Pat Jones", email: "pat@acme.test" } };
  it("starts from the recommended option and the person who booked the call", () => {
    expect(formOf(null, defaults)).toEqual({ optionId: "b", scopeNotes: "", extraAssumptions: "", extraOutOfScope: "", careDeclined: false, contactName: "Pat Jones", contactEmail: "pat@acme.test" });
    expect(formOf(null, { recommendedOptionId: null, contact: null })).toMatchObject({ optionId: "b", contactName: "", contactEmail: "" });
  });
  it("reads a saved draft back without the standard assumptions", () => {
    const base = proposal();
    const saved = doc({ content: { ...base, optionId: "c", scopeNotes: "Notes", assumptions: [...DEFAULT_ASSUMPTIONS, "Parking is free."], outOfScope: [...DEFAULT_OUT_OF_SCOPE, "Photos", "Video"], careDeclined: true } });
    expect(formOf(saved, defaults)).toMatchObject({ optionId: "c", scopeNotes: "Notes", extraAssumptions: "Parking is free.", extraOutOfScope: "Photos\nVideo", careDeclined: true, contactName: "Pat Jones" });
  });
  it("turns the form into edits, one entry per line, blanks dropped", () => {
    const f = { ...formOf(null, defaults), scopeNotes: "  Hello  ", extraAssumptions: "One\n\n  Two  \n", extraOutOfScope: "" };
    expect(editsOf(f)).toEqual({ scopeNotes: "Hello", extraAssumptions: ["One", "Two"], extraOutOfScope: [], careDeclined: false });
  });
  it("a contact is both fields, or neither", () => {
    const f = formOf(null, defaults);
    expect(contactOf(f)).toEqual({ name: "Pat Jones", email: "pat@acme.test" });
    expect(contactOf({ ...f, contactName: " ", contactEmail: "" })).toBeNull();
    expect(contactOf({ ...f, contactEmail: "" })).toBe("incomplete");
  });
  it("is dirty only when something differs from what is saved", () => {
    const saved = doc({ content: { ...proposal(), assumptions: [...DEFAULT_ASSUMPTIONS], outOfScope: [...DEFAULT_OUT_OF_SCOPE] } });
    const f = formOf(saved, defaults);
    expect(isProposalDirty(f, saved, defaults)).toBe(false);
    expect(isProposalDirty({ ...f, scopeNotes: f.scopeNotes + " " }, saved, defaults)).toBe(false);
    expect(isProposalDirty({ ...f, scopeNotes: "More" }, saved, defaults)).toBe(true);
    expect(isProposalDirty(formOf(null, defaults), null, defaults)).toBe(false);
    expect(isProposalDirty({ ...formOf(null, defaults), optionId: "a" }, null, defaults)).toBe(true);
  });
});

describe("depositLine", () => {
  const signed = doc({ status: "signed", signedAt: "2026-12-02T09:00:00.000Z" }); // the fixture's deposit is 199850
  it("is null until the proposal is signed: nothing is owed yet", () => {
    for (const status of ["draft", "sent", "viewed", "void", "expired"] as const) expect(depositLine(doc({ status }), null), status).toBeNull();
  });
  it("a signed proposal with no invoice says not created and offers the retry", () => {
    expect(depositLine(signed, null)).toEqual({ text: "Deposit $1,998.50: not created", retry: true });
  });
  it("an invoice says where it stands, with no retry", () => {
    expect(depositLine(signed, { status: "open", mismatch: null })).toEqual({ text: "Deposit $1,998.50: open.", retry: false });
    expect(depositLine(signed, { status: "paid", mismatch: null })).toEqual({ text: "Deposit $1,998.50: paid.", retry: false });
    expect(depositLine(signed, { status: "void", mismatch: null })).toMatchObject({ text: expect.stringContaining("void"), retry: false });
    expect(depositLine(signed, { status: "failed", mismatch: null })!.text).toMatch(/payment failed/);
  });
  it("uses the amount the signed proposal froze, and says so when a payment did not match", () => {
    const content = { ...proposal(), schedule: { ...proposal().schedule, depositCents: 154999 } };
    expect(depositLine(doc({ status: "signed", content }), null)!.text).toBe("Deposit $1,549.99: not created");
    expect(depositLine(signed, { status: "open", mismatch: "amount paid 100 is not the 199850 invoiced" })!.text)
      .toBe("Deposit $1,998.50: open. Stripe reported a payment that did not match: amount paid 100 is not the 199850 invoiced.");
  });
});
