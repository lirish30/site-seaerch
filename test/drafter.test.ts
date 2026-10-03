import { describe, it, expect } from "vitest";
import { buildPrompt, generateDraft, wordCount, type DraftInput } from "../src/worker/drafter/draft";
import type { Business, Contact, Settings } from "../src/worker/types";

const settings: Settings = {
  your_name: "Logan Irish", business_name: "Irish Web", contact_email: "l@x.com", services_blurb: "I build and care for small-business sites.",
  signature: "Logan Irish\nIrish Web", physical_address: "123 Main St, Boise, ID 83702",
  opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "Plain, friendly, no hype.", monthly_spend_limit_usd: 25,
};
const business = { id: "b1", name: "Ace Plumbing", category: "Plumber", address: "Boise, ID", website_url: "https://ace.com" } as Business;
const contacts: Contact[] = [
  { id: "c1", business_id: "b1", type: "email", value: "info@ace.com", source_url: "https://ace.com/contact", person_name: null, role: null, confidence: 0.7 },
];
const input: DraftInput = {
  settings, business, contacts, offer: "performance", steeringNote: null,
  findings: [
    { code: "slow_mobile", group: "speed", severity: "high", points: 25, evidence: "Scores 34/100 on Google's mobile speed test" },
    { code: "slow_lcp", group: "speed", severity: "medium", points: 10, evidence: "Main content takes about 8.4 seconds to appear on a phone" },
    { code: "old_copyright", group: "stale", severity: "medium", points: 10, evidence: "The footer still says © 2019" },
    { code: "layout_shift", group: "speed", severity: "low", points: 5, evidence: "The page jumps around while it loads" },
  ],
};
const body = (extra = "") => `Hi Ace team,\n\nYour site takes about 8 seconds to load on a phone.${extra}\n\nLogan Irish\nIrish Web\n123 Main St, Boise, ID 83702\nReply 'no thanks' and I won't follow up.`;

describe("buildPrompt", () => {
  it("includes only top 3 findings, offer, contacts, tone, footer, and banned jargon rule", () => {
    const p = buildPrompt(input);
    expect(p.user).toContain("Scores 34/100");
    expect(p.user).not.toContain("jumps around");
    expect(p.user).toContain("performance");
    expect(p.user).toContain("c1: info@ace.com");
    expect(p.system).toContain("Plain, friendly, no hype.");
    expect(p.system).toContain("123 Main St, Boise, ID 83702");
    expect(p.system).toMatch(/120 words/);
    expect(p.system).toMatch(/LCP/);
  });
  it("includes steering note when given", () => {
    expect(buildPrompt({ ...input, steeringNote: "mention I'm local" }).user).toContain("mention I'm local");
  });
});

describe("generateDraft", () => {
  it("returns validated draft", async () => {
    const d = await generateDraft(input, async () => ({ subject: "Quick note about ace.com", body: body(), to_contact_id: "c1", recipient_reason: "info inbox" }));
    expect(d.to_contact_id).toBe("c1");
    expect(d.subject).toBe("Quick note about ace.com");
  });

  it("rejects hallucinated contact id and falls back to recipient ranking", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: body(), to_contact_id: "made-up", recipient_reason: "x" }));
    expect(d.to_contact_id).toBe("c1");
  });

  it("null contact when no email contacts exist, reason from ranking", async () => {
    const form: Contact = { ...contacts[0], id: "f1", type: "form", value: "https://ace.com/contact" };
    const d = await generateDraft({ ...input, contacts: [form] }, async () => ({ subject: "s", body: body(), to_contact_id: "f1", recipient_reason: "x" }));
    expect(d.to_contact_id).toBeNull();
    expect(d.recipient_reason).toMatch(/contact form/);
  });

  it("appends missing address and opt-out verbatim", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: "Hi,\n\nShort note.\n\nLogan", to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.body).toContain("123 Main St, Boise, ID 83702");
    expect(d.body).toContain("Reply 'no thanks' and I won't follow up.");
  });

  it("retries once on malformed output, then succeeds", async () => {
    let n = 0;
    const d = await generateDraft(input, async () => (n++ === 0 ? { nope: true } : { subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }));
    expect(n).toBe(2);
    expect(d.subject).toBe("s");
  });

  it("throws after two malformed outputs", async () => {
    await expect(generateDraft(input, async () => ({ nope: true }))).rejects.toThrow(/malformed/i);
  });

  it("wordCount counts words", () => {
    expect(wordCount("a b  c\n d")).toBe(4);
  });
});
