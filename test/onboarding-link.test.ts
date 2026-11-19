import { describe, expect, it } from "vitest";
import { linkProblem } from "../src/worker/mail/send";
import { onboardingLink } from "../src/worker/onboarding/link";

describe("onboardingLink", () => {
  it("is the client base, /o/ and the token, on https only", () => {
    expect(onboardingLink("https://clients.example.com", "tok_123")).toBe("https://clients.example.com/o/tok_123");
    expect(onboardingLink("https://clients.example.com/", "tok_123")).toBe("https://clients.example.com/o/tok_123");
  });

  it("is null for a base that is not https, is workers.dev, or is missing", () => {
    for (const bad of ["http://clients.example.com", "https://app.workers.dev", "not a url", "", undefined]) expect(onboardingLink(bad, "tok_123"), String(bad)).toBeNull();
  });

  it("cold mail may not carry an onboarding link on a host other than the outreach host", () => {
    const text = "Your page: https://clients.example.com/o/tok_123";
    expect(linkProblem({ text, html: "" }, "outreach", "https://go.example.com")).toMatch(/clients\.example\.com/);
    expect(linkProblem({ text: "https://go.example.com/o/tok_123", html: "" }, "outreach", "https://go.example.com")).toBeNull();
    // The main mailbox is the one that carries it to a client.
    expect(linkProblem({ text, html: "" }, "main", "https://go.example.com")).toBeNull();
  });
});
