import { describe, expect, it } from "vitest";
import { AUTHORITY_LABEL, CONSENT_LABEL, ESIGN_DISCLOSURE, ESIGN_VERSION, authorityLabel } from "../src/worker/documents/consent";

describe("ESIGN disclosure", () => {
  it("the disclosure covers consent, paper copy, withdrawal, requirements and signature intent", () => {
    expect(ESIGN_DISCLOSURE).toMatch(/consent to electronic records and signatures/i);
    expect(ESIGN_DISCLOSURE).toMatch(/paper copy/i);
    expect(ESIGN_DISCLOSURE).toMatch(/by (replying by )?email/i);
    expect(ESIGN_DISCLOSURE).toMatch(/withdraw your consent/i);
    expect(ESIGN_DISCLOSURE).toMatch(/close this page/i);
    expect(ESIGN_DISCLOSURE).toMatch(/current web browser/i);
    expect(ESIGN_DISCLOSURE).toMatch(/email address/i);
    expect(ESIGN_DISCLOSURE).toMatch(/typing your name is your signature/i);
    expect(ESIGN_DISCLOSURE).toMatch(/you intend that typed name to be your legal signature/i);
  });

  it("is plain text in paragraphs with no markup or links", () => {
    expect(ESIGN_DISCLOSURE.split("\n\n")).toHaveLength(5);
    expect(ESIGN_DISCLOSURE).not.toMatch(/[<>]|https?:/);
  });

  it("has a version and the two checkbox labels", () => {
    expect(ESIGN_VERSION).toBe(1);
    expect(CONSENT_LABEL).toMatch(/electronic records and signatures/);
    expect(authorityLabel("Ace Plumbing")).toBe("I am authorized to sign for Ace Plumbing");
    expect(AUTHORITY_LABEL).toMatch(/authorized to sign/);
  });
});
