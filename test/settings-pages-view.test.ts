import { describe, expect, it } from "vitest";
import {
  billingLine, billingProblem, bookingSummary, documentsProblem, documentsSummary, hasBuiltSignature, isHttps, prettyLink, profileMissing, readDocumentsDraft, safeLink, samplesNeeded, samplesNudge, setupItems, setupSentence, suppressionWord, voiceSummary,
} from "../src/client/settingsPagesView";
import type { Service, Suppression } from "../src/client/types";

const sample = (result: string) => ({ id: "x", title: "t", url: "https://a.com", result_line: result, tags: "" });
const svc = (active: boolean) => ({ active }) as Service;

describe("links", () => {
  it("accepts http(s) and bare domains, refuses everything else", () => {
    expect(safeLink("irishweb.studio/work")).toBe("https://irishweb.studio/work");
    expect(safeLink("http://a.com")).toBe("http://a.com/");
    expect(["javascript:alert(1)", "mailto:a@b.co", "not a link", "nodots", ""].map(safeLink)).toEqual(["", "", "", "", ""]);
  });
  it("wants https:// for images and logos", () => {
    expect(isHttps("https://x.com/a.png")).toBe(true);
    expect([" http://x.com/a.png", "x.com/a.png", "https://", "https://a b.com"].map(isHttps)).toEqual([false, false, false, false]);
  });
  it("shows a link without scheme, www or trailing slash", () => expect(prettyLink("https://www.riversidedental.com/")).toBe("riversidedental.com"));
});

describe("overview status", () => {
  it("names the voice by tone and length, falling back to the defaults", () => {
    expect(voiceSummary("direct", "long")).toBe("Direct & short · Long");
    expect(voiceSummary("", "")).toBe("Friendly local · Short");
  });
  it("counts how many more samples would give drafts a choice", () => {
    expect(samplesNeeded([sample("up 40%"), sample(""), sample("  ")])).toBe(5);
    expect(samplesNeeded(Array.from({ length: 8 }, () => sample("a")))).toBe(0);
    expect(samplesNudge(2)).toBe("Two more samples with results would give drafts more to choose from.");
    expect(samplesNudge(1)).toBe("One more sample with a result would give drafts more to choose from.");
  });
  it("finds the profile gaps", () => {
    expect(profileMissing({ your_name: "A", business_name: "", contact_email: " " })).toEqual(["your business name", "a contact email"]);
  });
  it("treats a signature as built once it has a name, email or link", () => {
    expect(hasBuiltSignature({ signature_json: "" })).toBe(false);
    expect(hasBuiltSignature({ signature_json: JSON.stringify({ name: "Logan" }) })).toBe(true);
    expect(hasBuiltSignature({ signature_json: JSON.stringify({ phone: "123" }) })).toBe(false);
  });
  it("lists what is left in setup order and words it", () => {
    const doc = { your_name: "A", business_name: "B", contact_email: "a@b.co", services_blurb: "x", signature_json: JSON.stringify({ name: "A" }) };
    const samples = Array.from({ length: 7 }, () => sample("a"));
    const items = setupItems({ doc, samples, services: [svc(true)] });
    expect(items.filter((i) => !i.done).map((i) => i.key)).toEqual(["samples"]);
    expect(setupSentence(items, samples)).toBe("Add one more work sample.");
    expect(setupSentence(setupItems({ doc, samples: Array.from({ length: 8 }, () => sample("a")), services: [svc(true)] }), samples)).toBe("");
  });
  it("sums up suppressions", () => {
    const d = (kind: "domain" | "place_id") => ({ kind }) as Suppression;
    expect(suppressionWord([d("domain")])).toBe("1 domain");
    expect(suppressionWord([d("domain"), d("place_id")])).toBe("2 entries");
  });
});

describe("bookingSummary", () => {
  it("warns when no hours are set and counts the weekly windows once they are", () => {
    expect(bookingSummary("{}")).toEqual({ tone: "warning", text: "No hours set" });
    expect(bookingSummary("")).toEqual({ tone: "warning", text: "No hours set" });
    expect(bookingSummary(JSON.stringify({ windows: [{ weekday: 2, start: "09:00", end: "11:00" }] }))).toEqual({ tone: "positive", text: "1 weekly window" });
    expect(bookingSummary(JSON.stringify({ windows: [{ weekday: 2, start: "09:00", end: "11:00" }, { weekday: 3, start: "09:00", end: "11:00" }] })).text).toBe("2 weekly windows");
  });
});

describe("documents settings helpers", () => {
  it("reads a half-finished edit as typed, and the defaults for nothing", () => {
    expect(readDocumentsDraft("")).toEqual({ legalReviewedAt: null, legalReviewer: "", lateFeePercentMonthly: 1.5, expiryDays: 30 });
    expect(readDocumentsDraft("[]").expiryDays).toBe(30);
    expect(readDocumentsDraft(JSON.stringify({ legalReviewedAt: "2026-12-01T00:00:00.000Z" })).legalReviewer).toBe("");
  });
  it("names what stops a save", () => {
    expect(documentsProblem(readDocumentsDraft("{}"))).toBeNull();
    expect(documentsProblem(readDocumentsDraft(JSON.stringify({ legalReviewedAt: "2026-12-01T00:00:00.000Z" })))).toBe("Name who reviewed the clauses");
    expect(documentsProblem(readDocumentsDraft(JSON.stringify({ expiryDays: 3 })))).toMatch(/7 and 90/);
    expect(documentsProblem(readDocumentsDraft(JSON.stringify({ lateFeePercentMonthly: 11 })))).toMatch(/0% and 10%/);
  });
  it("the overview chip warns until a review is recorded", () => {
    expect(documentsSummary("{}")).toEqual({ tone: "warning", text: "Not lawyer-reviewed" });
    expect(documentsSummary(JSON.stringify({ legalReviewedAt: "2026-12-01T00:00:00.000Z", legalReviewer: "A. Lawyer" }))).toEqual({ tone: "positive", text: "Reviewed 2026-12-01" });
    expect(documentsSummary(JSON.stringify({ legalReviewedAt: "2026-12-01T00:00:00.000Z" })).tone).toBe("warning");
  });
});

describe("billing line", () => {
  it("names the mode, the webhook secret and the client base", () => {
    expect(billingLine({ stripeMode: "test", webhookConfigured: true, clientBase: "https://clients.example.com" })).toBe("Stripe: test mode · webhook secret set · client links on https://clients.example.com");
    expect(billingLine({ stripeMode: "live", webhookConfigured: false, clientBase: null })).toBe("Stripe: live mode · webhook secret not set · client links off");
    expect(billingLine({ stripeMode: null, webhookConfigured: false, clientBase: null })).toBe("Stripe: not set up · webhook secret not set · client links off");
  });
  it("says what is missing, in the order it blocks", () => {
    expect(billingProblem({ stripeMode: null, webhookConfigured: true, clientBase: "https://c.example" })).toMatch(/STRIPE_SECRET_KEY/);
    expect(billingProblem({ stripeMode: "test", webhookConfigured: false, clientBase: "https://c.example" })).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(billingProblem({ stripeMode: "test", webhookConfigured: true, clientBase: null })).toMatch(/CLIENT_LINK_BASE/);
    expect(billingProblem({ stripeMode: "live", webhookConfigured: true, clientBase: "https://c.example" })).toBeNull();
  });
});
