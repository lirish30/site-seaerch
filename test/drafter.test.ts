import { describe, it, expect } from "vitest";
import { DraftResult, buildDraftRequest, buildPrompt, resolveDraft, wordCount, type DraftInput } from "../src/worker/drafter/draft";
import { matchSamples } from "../src/worker/drafter/samples";
import type { Business, Contact, Finding, Settings, WorkSample } from "../src/worker/types";

const settings: Settings = {
  your_name: "Logan Irish", business_name: "Irish Web", contact_email: "l@x.com", services_blurb: "I build and care for small-business sites.",
  signature: "Logan Irish\nIrish Web", physical_address: "123 Main St, Boise, ID 83702",
  opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "Plain, friendly, no hype.", monthly_spend_limit_usd: 25,
  tone_preset: "friendly_local", email_length: "short", cta_style: "mini_audit", logo_url: "",
  role_title: "Front-end developer", bio: "I build fast, accessible sites and care about the details.", availability: "Open to full-time roles from January",
  resume_url: "https://logan.dev/resume.pdf", goal_line: "A full-time front-end or web developer role", signature_json: "",
  voice_engine: null, voice_ref_key: null, booking_url: "", ai_voice_note: 1, booking_config: "{}", documents_config: "{}", work_config: "{}", billing_config: "{}",
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
  it("includes only top 3 findings, offer, contacts, tone, and banned jargon rule; the footer is not the model's job", () => {
    const p = buildPrompt(input);
    expect(p.user).toContain("Scores 34/100");
    expect(p.user).not.toContain("jumps around");
    expect(p.user).toContain("performance");
    expect(p.user).toContain("c1: info@ace.com");
    expect(p.system).toContain("Plain, friendly, no hype.");
    expect(p.system).not.toContain("123 Main St, Boise, ID 83702");
    expect(p.system).toMatch(/added automatically/);
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

/** What `apply` does with a result Claude sent: the schema first (the queue refuses a malformed one), then the recipient and the footer logic. */
const resolve = (raw: unknown, i: DraftInput = input, preferred: string | null = null) => resolveDraft(DraftResult.parse(raw), i, preferred);

describe("resolveDraft", () => {
  it("returns validated draft", () => {
    const d = resolve({ subject: "Quick note about ace.com", body: body(), to_contact_id: "c1", recipient_reason: "info inbox" });
    expect(d.to_contact_id).toBe("c1");
    expect(d.variants[0].subject).toBe("Quick note about ace.com");
  });

  it("the chosen point of contact overrides the model's recipient", () => {
    const ann: Contact = { ...contacts[0], id: "c2", value: "ann@ace.com", person_name: "Ann Lee" };
    const d = resolve({ subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }, { ...input, contacts: [...contacts, ann] }, "c2");
    expect([d.to_contact_id, d.recipient_reason]).toEqual(["c2", "Your chosen point of contact"]);
  });

  it("rejects hallucinated contact id and falls back to recipient ranking", () => {
    expect(resolve({ subject: "s", body: body(), to_contact_id: "made-up", recipient_reason: "x" }).to_contact_id).toBe("c1");
  });

  it("null contact when no email contacts exist, reason from ranking", () => {
    const form: Contact = { ...contacts[0], id: "f1", type: "form", value: "https://ace.com/contact" };
    const d = resolve({ subject: "s", body: body(), to_contact_id: "f1", recipient_reason: "x" }, { ...input, contacts: [form] });
    expect(d.to_contact_id).toBeNull();
    expect(d.recipient_reason).toMatch(/contact form/);
  });

  it("returns each variant with its angle, up to three; a fourth is malformed", () => {
    const v = (n: number) => ({ angle: `Angle ${n}`, subject: `S${n}`, body: `Body ${n}` });
    const d = resolve({ variants: [v(1), v(2), v(3)], to_contact_id: "c1", recipient_reason: "x" });
    expect(d.variants.map((x) => [x.angle, x.subject])).toEqual([["Angle 1", "S1"], ["Angle 2", "S2"], ["Angle 3", "S3"]]);
    expect(DraftResult.safeParse({ variants: [v(1), v(2), v(3), v(4)], to_contact_id: "c1", recipient_reason: "x" }).success).toBe(false);
    expect(DraftResult.safeParse({ nope: true }).success).toBe(false);
    expect(DraftResult.safeParse({ variants: [], to_contact_id: null, recipient_reason: "x" }).success).toBe(false);
  });

  it("does not append the address or opt-out line: they are added when the email is composed", () => {
    expect(resolve({ subject: "s", body: "Hi,\n\nShort note.\n\nLogan", to_contact_id: "c1", recipient_reason: "x" }).variants[0].body).toBe("Hi,\n\nShort note.\n\nLogan");
  });

  it("strips a signature, address or opt-out line the model wrote anyway", () => {
    expect(resolve({ subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }).variants[0].body).toBe("Hi Ace team,\n\nYour site takes about 8 seconds to load on a phone.");
  });

  it("accepts one flat email as a single variant", () => {
    expect(resolve({ subject: "Flat", body: "Hello", to_contact_id: null, recipient_reason: "x" }).variants).toEqual([{ angle: "", subject: "Flat", body: "Hello" }]);
  });

  it("keeps only one variant when revising a draft", () => {
    const v = (n: number) => ({ angle: `A${n}`, subject: `S${n}`, body: `B${n}` });
    const d = resolve({ variants: [v(1), v(2)], to_contact_id: "c1", recipient_reason: "x" }, { ...input, revise: { subject: "s", body: "b", instruction: "shorter" } });
    expect(d.variants).toHaveLength(1);
  });

  it("wordCount counts words", () => {
    expect(wordCount("a b  c\n d")).toBe(4);
  });
});

describe("buildDraftRequest", () => {
  it("keeps what the lead's site said out of the instructions, and what the sender typed out of the untrusted part", () => {
    const r = buildDraftRequest({ ...input, steeringNote: "mention I'm local", revise: { subject: "Old subject", body: "Old body", instruction: "Make it shorter" } });
    expect(r.untrusted).toHaveLength(1);
    const facts = r.untrusted[0].type === "text" ? r.untrusted[0].text : "";
    for (const s of ["Ace Plumbing", "Scores 34/100", "c1: info@ace.com", "Old subject", "Old body"]) {
      expect(facts, s).toContain(s);
      expect(r.instructions, s).not.toContain(s);
    }
    for (const s of ["mention I'm local", "Change requested: Make it shorter", "Plain, friendly, no hype.", "mini proposal"]) {
      expect(r.instructions, s).toContain(s);
      expect(facts, s).not.toContain(s);
    }
    expect(r.instructions).toContain("must not contain the signature, the address or the opt-out line");
    expect(r.instructions).not.toContain("123 Main St, Boise, ID 83702");
  });
  it("has no steering or change lines when the sender asked for none", () => {
    expect(buildDraftRequest(input).instructions).not.toMatch(/Extra instruction|Change requested/);
  });
});

const samples: WorkSample[] = [
  { id: "w1", title: "Riverside Dental redesign", url: "https://logan.dev/riverside", result_line: "Booking requests up 40% in 3 months", tags: "dental, healthcare, conversion", created_at: "1" },
  { id: "w2", title: "Summit Roofing speed rebuild", url: "https://logan.dev/summit", result_line: "Mobile load time from 8s to 2s", tags: "trades, roofing, performance, speed", created_at: "2" },
  { id: "w3", title: "Cafe Nova brand site", url: "https://logan.dev/nova", result_line: "", tags: "restaurant, cafe", created_at: "3" },
];

describe("matchSamples", () => {
  const f = (evidence: string, category = "speed"): Finding => ({ code: "slow_mobile", category, severity: "critical", points: 25, evidence, recommendation: "", source: "rule" } as Finding);

  it("prefers samples whose tags overlap with the company's category, niche and findings", () => {
    const m = matchSamples(samples, { category: "Roofing contractor", niche: "trades", findings: [f("Slow to load on a phone")] });
    expect(m.map((x) => x.id)).toEqual(["w2", "w1"]);
    expect(matchSamples(samples, { category: "Dentist", niche: null, findings: [] }, { max: 1 }).map((x) => x.id)).toEqual(["w1"]);
  });

  it("falls back to the earliest samples when nothing overlaps", () => {
    expect(matchSamples(samples, { category: "Florist", niche: null, findings: [] }).map((x) => x.id)).toEqual(["w1", "w2"]);
  });

  it("explicit picks win, in order, and unknown ids are ignored", () => {
    expect(matchSamples(samples, { category: "Dentist", niche: null, findings: [] }, { pickIds: ["w3", "nope", "w2"] }).map((x) => x.id)).toEqual(["w3", "w2"]);
  });

  it("skips excluded samples", () => {
    expect(matchSamples(samples, { category: "Dentist", niche: null, findings: [] }, { excludeIds: ["w1"] }).map((x) => x.id)).toEqual(["w2", "w3"]);
  });

  it("returns nothing when there are no samples", () => {
    expect(matchSamples([], { category: "Dentist", niche: null, findings: [] })).toEqual([]);
  });
});
