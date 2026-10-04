import { describe, it, expect } from "vitest";
import { anthropicCaller, buildPrompt, generateDraft, wordCount, type DraftInput } from "../src/worker/drafter/draft";
import type { Business, Contact, Settings } from "../src/worker/types";

const settings: Settings = {
  your_name: "Logan Irish", business_name: "Irish Web", contact_email: "l@x.com", services_blurb: "I build and care for small-business sites.",
  signature: "Logan Irish\nIrish Web", physical_address: "123 Main St, Boise, ID 83702",
  opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "Plain, friendly, no hype.", monthly_spend_limit_usd: 25,
  tone_preset: "friendly_local", email_length: "short", cta_style: "mini_audit",
};
const business = { id: "b1", name: "Ace Plumbing", category: "Plumber", address: "Boise, ID", website_url: "https://ace.com" } as Business;
const contacts: Contact[] = [
  { id: "c1", business_id: "b1", type: "email", value: "info@ace.com", source_url: "https://ace.com/contact", person_name: null, role: null, confidence: 0.7 },
];
const input: DraftInput = {
  settings, business, contacts, offer: "performance", steeringNote: null,
  findings: [
    { code: "slow_mobile", category: "speed", severity: "critical", points: 25, evidence: "Scores 34/100 on Google's mobile speed test", recommendation: "", source: "rule" },
    { code: "slow_lcp", category: "speed", severity: "important", points: 10, evidence: "Main content takes about 8.4 seconds to appear on a phone", recommendation: "", source: "rule" },
    { code: "old_copyright", category: "content", severity: "important", points: 10, evidence: "The footer still says © 2019", recommendation: "", source: "rule" },
    { code: "layout_shift", category: "speed", severity: "nice", points: 5, evidence: "The page jumps around while it loads", recommendation: "", source: "rule" },
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
  it("is structured as a mini proposal with one call to action from settings", () => {
    const p = buildPrompt(input);
    expect(p.system).toMatch(/mini proposal/);
    expect(p.system).toContain("free website audit report");
    expect(buildPrompt({ ...input, settings: { ...settings, cta_style: "call" } }).system).toContain("10-minute call");
  });

  it("applies the account tone and length, and a per-draft tone override", () => {
    expect(buildPrompt(input).system).toContain("Warm, plain-spoken neighbour");
    expect(buildPrompt({ ...input, settings: { ...settings, email_length: "long" } }).system).toMatch(/under 250 words/);
    const p = buildPrompt({ ...input, tone: "formal" });
    expect(p.system).toContain("Professional and polished");
    expect(p.system).not.toContain("Warm, plain-spoken");
  });

  it("leads with chosen issues (with their fixes) instead of the top three", () => {
    const focus = [{ ...input.findings[3], recommendation: "Reserve space for images" }];
    const p = buildPrompt({ ...input, focus });
    expect(p.user).toContain("Lead with these issues (the sender chose them):");
    expect(p.user).toContain("jumps around while it loads (fix: Reserve space for images)");
    expect(p.user).not.toContain("Scores 34/100");
  });

  it("adds niche goal, value proposition and the point of contact", () => {
    const p = buildPrompt({ ...input, niche: "trades", valueProposition: "Emergency plumbing in Boise", poc: { name: "Ann Lee", role: "Owner" } });
    expect(p.user).toContain("Industry: Home services / trades; their website's job is quote requests and phone calls");
    expect(p.user).toContain("What their site says they do: Emergency plumbing in Boise");
    expect(p.user).toContain("Address the email to: Ann Lee (Owner)");
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

  it("the chosen point of contact overrides the model's recipient", async () => {
    const ann: Contact = { ...contacts[0], id: "c2", value: "ann@ace.com", person_name: "Ann Lee" };
    const d = await generateDraft({ ...input, contacts: [...contacts, ann] },
      async () => ({ subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }), "c2");
    expect([d.to_contact_id, d.recipient_reason]).toEqual(["c2", "Your chosen point of contact"]);
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

describe("anthropicCaller request", () => {
  it("does not force tool_choice (claude-sonnet-5-5 rejects type tool/any)", async () => {
    let sent: any = null;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: sent.model, stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "write_email", input: { subject: "s", body: "b", to_contact_id: null, recipient_reason: "r" } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const out = await anthropicCaller("sk-test")({ system: "sys", user: "usr" });
      expect(out).toMatchObject({ subject: "s" });
      expect(sent.tool_choice?.type ?? "auto").toBe("auto");
    } finally { globalThis.fetch = orig; }
  });
});
