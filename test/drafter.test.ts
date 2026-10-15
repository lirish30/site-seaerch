import { describe, it, expect, vi } from "vitest";
import { anthropicCaller, buildPrompt, generateDraft, wordCount, type DraftInput } from "../src/worker/drafter/draft";
import { buildFullTimePrompt } from "../src/worker/drafter/prompt";
import { matchSamples } from "../src/worker/drafter/samples";
import type { Business, Contact, Finding, Settings, WorkSample } from "../src/worker/types";

const settings: Settings = {
  your_name: "Logan Irish", business_name: "Irish Web", contact_email: "l@x.com", services_blurb: "I build and care for small-business sites.",
  signature: "Logan Irish\nIrish Web", physical_address: "123 Main St, Boise, ID 83702",
  opt_out_line: "Reply 'no thanks' and I won't follow up.", tone_notes: "Plain, friendly, no hype.", monthly_spend_limit_usd: 25,
  tone_preset: "friendly_local", email_length: "short", cta_style: "mini_audit", logo_url: "",
  role_title: "Front-end developer", bio: "I build fast, accessible sites and care about the details.", availability: "Open to full-time roles from January",
  resume_url: "https://logan.dev/resume.pdf", goal_line: "A full-time front-end or web developer role", signature_json: "", default_purpose: "full_time", role_kind_order: "web_dev,cro,seo,design,marketing",
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

describe("generateDraft", () => {
  it("returns validated draft", async () => {
    const d = await generateDraft(input, async () => ({ subject: "Quick note about ace.com", body: body(), to_contact_id: "c1", recipient_reason: "info inbox" }));
    expect(d.to_contact_id).toBe("c1");
    expect(d.variants[0].subject).toBe("Quick note about ace.com");
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

  it("returns each variant with its angle, up to three", async () => {
    const v = (n: number) => ({ angle: `Angle ${n}`, subject: `S${n}`, body: `Body ${n}` });
    const d = await generateDraft(input, async () => ({ variants: [v(1), v(2), v(3)], to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.variants.map((x) => [x.angle, x.subject])).toEqual([["Angle 1", "S1"], ["Angle 2", "S2"], ["Angle 3", "S3"]]);
    // A fourth variant is malformed output: retried once, then thrown.
    await expect(generateDraft(input, async () => ({ variants: [v(1), v(2), v(3), v(4)], to_contact_id: "c1", recipient_reason: "x" }))).rejects.toThrow(/malformed/i);
  });

  it("does not append the address or opt-out line: they are added when the email is composed", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: "Hi,\n\nShort note.\n\nLogan", to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.variants[0].body).toBe("Hi,\n\nShort note.\n\nLogan");
  });

  it("strips a signature, address or opt-out line the model wrote anyway", async () => {
    const d = await generateDraft(input, async () => ({ subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.variants[0].body).toBe("Hi Ace team,\n\nYour site takes about 8 seconds to load on a phone.");
  });

  it("accepts one flat email as a single variant", async () => {
    const d = await generateDraft(input, async () => ({ subject: "Flat", body: "Hello", to_contact_id: null, recipient_reason: "x" }));
    expect(d.variants).toEqual([{ angle: "", subject: "Flat", body: "Hello" }]);
  });

  it("keeps only one variant when revising a draft", async () => {
    const v = (n: number) => ({ angle: `A${n}`, subject: `S${n}`, body: `B${n}` });
    const d = await generateDraft({ ...input, revise: { subject: "s", body: "b", instruction: "shorter" } },
      async () => ({ variants: [v(1), v(2)], to_contact_id: "c1", recipient_reason: "x" }));
    expect(d.variants).toHaveLength(1);
  });

  it("retries once on malformed output, then succeeds", async () => {
    let n = 0;
    const d = await generateDraft(input, async () => (n++ === 0 ? { nope: true } : { subject: "s", body: body(), to_contact_id: "c1", recipient_reason: "x" }));
    expect(n).toBe(2);
    expect(d.variants[0].subject).toBe("s");
  });

  it("throws after two malformed outputs", async () => {
    await expect(generateDraft(input, async () => ({ nope: true }))).rejects.toThrow(/malformed/i);
  });

  it("wordCount counts words", () => {
    expect(wordCount("a b  c\n d")).toBe(4);
  });
});

describe("anthropicCaller request", () => {
  it("does not force tool_choice (forcing would skip thinking)", async () => {
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

describe("anthropicCaller", () => {
  it("does not force tool use, which the draft model rejects", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "tool_use", input: { subject: "s" } }] }));
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
    vi.resetModules();
    const { anthropicCaller: caller } = await import("../src/worker/drafter/draft");
    const out = await caller("k")({ system: "sys", user: "usr" });
    const req = (create.mock.calls[0] as unknown as [any])[0];
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.system).toContain("write_email");
    expect(out).toEqual({ subject: "s" });
    vi.doUnmock("@anthropic-ai/sdk");
  });
});

const samples: WorkSample[] = [
  { id: "w1", title: "Riverside Dental redesign", url: "https://logan.dev/riverside", result_line: "Booking requests up 40% in 3 months", tags: "dental, healthcare, conversion", created_at: "1" },
  { id: "w2", title: "Summit Roofing speed rebuild", url: "https://logan.dev/summit", result_line: "Mobile load time from 8s to 2s", tags: "trades, roofing, performance, speed", created_at: "2" },
  { id: "w3", title: "Cafe Nova brand site", url: "https://logan.dev/nova", result_line: "", tags: "restaurant, cafe", created_at: "3" },
];

describe("buildFullTimePrompt", () => {
  const ft: DraftInput = { ...input, purpose: "full_time", samples: samples.slice(0, 2) };

  it("is chosen by purpose and is about the sender, not a website review", () => {
    const p = buildPrompt(ft);
    expect(p.system).toContain("looking for a full-time role");
    expect(p.system).toMatch(/about the SENDER/);
    expect(p.system).toMatch(/not a website review and not a sales pitch/);
    expect(p.system).toMatch(/never pretend one is open/);
    expect(p.system).not.toContain("mini proposal");
    expect(p.system).not.toContain("free website audit report");
    expect(buildPrompt(input).system).toContain("mini proposal");
  });

  it("leads with the person and allows only one light nod to the site, with no fix steps", () => {
    const p = buildFullTimePrompt(ft);
    expect(p.system).toMatch(/Lead with the person, never with a problem on the site/);
    expect(p.system).toMatch(/single sentence/);
    expect(p.system).toMatch(/NO list of issues, NO fix steps/);
    expect(p.system).toMatch(/NO offer to fix or to talk about the issue/);
    expect(p.system).not.toMatch(/How they would approach it/);
  });

  it("does not hand the model the recommended fixes, so it has none to list", () => {
    const withFix = { ...ft, findings: [{ ...input.findings[0], recommendation: "Compress images and defer scripts" }] };
    expect(buildPrompt({ ...withFix, purpose: "freelance" }).user).toContain("(fix: Compress images and defer scripts)");
    const p = buildFullTimePrompt(withFix);
    expect(p.user).toContain("Scores 34/100 on Google's mobile speed test");
    expect(p.user).not.toContain("Compress images");
    expect(p.user).not.toContain("(fix:");
  });

  it("forbids inventing how the sender found the company, or praise the findings do not show", () => {
    const s = buildFullTimePrompt(ft).system;
    expect(s).toMatch(/no "I came across"/);
    expect(s).toMatch(/no device|on what device/);
    expect(s).toMatch(/Do not praise anything the findings do not show/);
  });

  it("carries the sender's profile and nothing about the footer", () => {
    const p = buildFullTimePrompt(ft);
    for (const t of ["Front-end developer", "I build fast, accessible sites", "Open to full-time roles from January", "A full-time front-end or web developer role", "https://logan.dev/resume.pdf"]) {
      expect(p.system).toContain(t);
    }
    expect(p.system).not.toContain("123 Main St");
    expect(p.system).not.toContain("no thanks");
  });

  it("lists only the given work samples and forbids inventing others", () => {
    const p = buildFullTimePrompt(ft);
    expect(p.user).toContain("- Riverside Dental redesign: https://logan.dev/riverside (Booking requests up 40% in 3 months)");
    expect(p.user).toContain("- Summit Roofing speed rebuild: https://logan.dev/summit");
    expect(p.user).not.toContain("Cafe Nova");
    expect(p.system).toMatch(/Never invent employers/);
    expect(p.system).toMatch(/never cite work that is not listed/);
  });

  it("says so when there are no samples, rather than leaving the model to make some up", () => {
    const p = buildFullTimePrompt({ ...ft, samples: [] });
    expect(p.user).toContain("Work samples you may cite (only these):\nnone");
    expect(p.system).toMatch(/cite no work and say they are happy to share examples/);
  });

  it("asks for three differently-angled variants, or one when revising", () => {
    expect(buildFullTimePrompt(ft).system).toMatch(/Write 3 variants/);
    expect(buildFullTimePrompt(ft).system).toMatch(/Intro-led/);
    const r = buildFullTimePrompt({ ...ft, revise: { subject: "Old subject", body: "Old body text", instruction: "Make it shorter." } });
    expect(r.system).toMatch(/exactly 1 variant/);
    expect(r.user).toContain("Subject: Old subject");
    expect(r.user).toContain("Old body text");
    expect(r.user).toContain("Change requested: Make it shorter.");
  });

  it("applies the length setting on its own scale and still honours chosen issues", () => {
    expect(buildFullTimePrompt(ft).system).toMatch(/under 150 words/);
    expect(buildFullTimePrompt({ ...ft, settings: { ...settings, email_length: "long" } }).system).toMatch(/under 280 words/);
    const p = buildFullTimePrompt({ ...ft, focus: [input.findings[3]] });
    expect(p.user).toContain("Something noticed on their site (the sender chose these; use one):");
    expect(p.user).not.toContain("Scores 34/100");
  });
});

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
