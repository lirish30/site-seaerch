import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateDraft, anthropicCaller, wordCount } from "../src/worker/drafter/draft";
import { matchSamples } from "../src/worker/drafter/samples";
import { composeEmail } from "../src/worker/email/render";
import type { Purpose, Settings, WorkSample } from "../src/worker/types";

// Live check of what the model writes. PURPOSE=full_time (default) or freelance; run both before changing a prompt.
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }
const purpose: Purpose = process.env.PURPOSE === "freelance" ? "freelance" : "full_time";

const settings: Settings = {
  your_name: "Logan Irish", business_name: process.env.BIZ_NAME ?? "Logan Irish Web", contact_email: "",
  services_blurb: "I build, speed up, and look after websites for small local businesses.",
  signature: "Logan Irish", physical_address: process.env.ADDRESS ?? "123 Main St, Boise, ID 83702",
  opt_out_line: "If you'd rather not hear from me, just reply \"no thanks\" and I won't follow up.",
  tone_notes: process.env.TONE ?? "", monthly_spend_limit_usd: 25,
  tone_preset: (process.env.TONE_PRESET as Settings["tone_preset"]) ?? "friendly_local",
  email_length: (process.env.EMAIL_LENGTH as Settings["email_length"]) ?? "short", cta_style: "mini_audit", logo_url: "",
  role_title: "Front-end developer", bio: "I build fast, accessible websites and care about the details. I have shipped sites for dental, trades and food businesses.",
  availability: "Open to full-time roles", resume_url: "https://example.com/resume.pdf",
  goal_line: "A full-time front-end or web developer role", signature_json: "", default_purpose: purpose, role_kind_order: "web_dev,cro,seo,design,marketing",
};
// Fixture work: the check fails if an email links to anything that is not one of these (or the resume).
const SAMPLES: WorkSample[] = [
  { id: "w1", title: "Riverside Dental redesign", url: "https://example.com/work/riverside", result_line: "Booking requests up 40% in three months", tags: "dental, healthcare, conversion", created_at: "1" },
  { id: "w2", title: "Summit Roofing speed rebuild", url: "https://example.com/work/summit", result_line: "Mobile load time from 8 seconds to 2", tags: "trades, roofing, speed, performance", created_at: "2" },
  { id: "w3", title: "Cafe Nova brand site", url: "https://example.com/work/nova", result_line: "", tags: "restaurant, cafe, menu", created_at: "3" },
];
const ALLOWED_URLS = new Set([...SAMPLES.map((s) => s.url), settings.resume_url]);
const MAX_WORDS = purpose === "full_time" ? { short: 170, medium: 230, long: 300 }[settings.email_length] : { short: 120, medium: 180, long: 250 }[settings.email_length];
// The first sentence after the greeting. A full-time email should open on the sender, not on a problem with the company's site.
const firstSentence = (body: string) => body.replace(/^\s*(?:hi|hello|dear)\b[^\n]*\n+/i, "").split(/(?<=[.!?])\s/)[0] ?? "";
const ABOUT_THEIR_SITE = /\byour\s+(?:site|website|homepage|home page|page)\b/i;
const JARGON = /\b(LCP|CLS|Core Web Vitals|meta description|viewport|SEO)\b/i;
const leads = JSON.parse(readFileSync("scripts/fixtures/leads.json", "utf8"));
const call = anthropicCaller(key);
let failures = 0; const out: string[] = [`# Prompt check: ${purpose}, up to ${MAX_WORDS} words\n`];

for (const l of leads) {
  const business = { id: "x", ...l.business };
  const samples = purpose === "full_time" ? matchSamples(SAMPLES, { category: business.category ?? null, niche: null, findings: l.findings }) : [];
  const d = await generateDraft({
    settings, business, findings: l.findings, offer: l.offer, contacts: l.contacts.map((c: any) => ({ business_id: "x", ...c })),
    steeringNote: null, purpose, samples,
  }, call);
  out.push(`## ${l.business.name} (${l.offer})\nTo: ${d.to_contact_id ?? "—"} (${d.recipient_reason})\n`);
  d.variants.forEach((v, n) => {
    const urls = v.body.match(/https?:\/\/[^\s)]+[^\s).,;]/g) ?? [];
    const checks = {
      variantCount: d.variants.length >= 1,
      underLimit: wordCount(v.body) <= MAX_WORDS,
      noFooterInBody: !v.body.includes(settings.physical_address) && !v.body.includes(settings.opt_out_line),
      noJargon: !JARGON.test(v.body),
      onlyKnownLinks: purpose === "freelance" || urls.every((u) => ALLOWED_URLS.has(u)),
      noFakeOpening: purpose === "freelance" || !/job posting|your opening|open position/i.test(v.body),
      // A full-time email is about the sender: no fix plan, no invented way of having looked, and it does not open on a site problem.
      noFixSteps: purpose === "freelance" || !/\bI(?:'d| would| will)\s+(?:start|begin|first|fix|improve|compress|trim|put|tackle)|\bmy approach|\bhere's how|\bI can fix/i.test(v.body),
      noViewingClaims: purpose === "freelance" || !/\b(on my phone|I tested|I ran|I checked|I was looking at|I came across|I stumbled)/i.test(v.body),
      opensOnPerson: purpose === "freelance" || !ABOUT_THEIR_SITE.test(firstSentence(v.body)),
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failures++;
    const e = composeEmail(settings, { subject: v.subject, body: v.body, include_footer: purpose === "freelance" });
    out.push(`### Variant ${n + 1}: ${v.angle || "(no angle)"} ${ok ? "PASS" : "FAIL " + JSON.stringify(checks)} (${wordCount(v.body)} words)\nSubject: ${v.subject}\n\n${e.text}\n`);
  });
}
mkdirSync("scripts/out", { recursive: true });
writeFileSync(`scripts/out/prompt-check-${purpose}.md`, out.join("\n"));
console.log(out.join("\n"));
console.log(failures ? `\n${failures} variant(s) failed checks` : "\nAll variants passed checks");
process.exit(failures ? 1 : 0);
