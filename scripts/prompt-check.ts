import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateDraft, anthropicCaller, wordCount } from "../src/worker/drafter/draft";
import { composeEmail } from "../src/worker/email/render";
import type { Purpose, Settings } from "../src/worker/types";

// Live check of what the model writes (freelance); run it before changing a prompt.
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }
const purpose: Purpose = "freelance";

const settings: Settings = {
  your_name: "Logan Irish", business_name: process.env.BIZ_NAME ?? "Logan Irish Web", contact_email: "",
  services_blurb: "I build, speed up, and look after websites for small local businesses.",
  signature: "Logan Irish", physical_address: process.env.ADDRESS ?? "123 Main St, Boise, ID 83702",
  opt_out_line: "If you'd rather not hear from me, just reply \"no thanks\" and I won't follow up.",
  tone_notes: process.env.TONE ?? "", monthly_spend_limit_usd: 25,
  tone_preset: (process.env.TONE_PRESET as Settings["tone_preset"]) ?? "friendly_local",
  email_length: (process.env.EMAIL_LENGTH as Settings["email_length"]) ?? "short", cta_style: "mini_audit", logo_url: "",
  role_title: "Front-end developer", bio: "I build fast, accessible websites and care about the details. I have shipped sites for dental, trades and food businesses.",
  availability: "Taking on agency projects", resume_url: "https://example.com/resume.pdf",
  goal_line: "Agency projects", signature_json: "",
};
const MAX_WORDS = { short: 120, medium: 180, long: 250 }[settings.email_length];
const JARGON = /\b(LCP|CLS|Core Web Vitals|meta description|viewport|SEO)\b/i;
const leads = JSON.parse(readFileSync("scripts/fixtures/leads.json", "utf8"));
const call = anthropicCaller(key);
let failures = 0; const out: string[] = [`# Prompt check: ${purpose}, up to ${MAX_WORDS} words\n`];

for (const l of leads) {
  const business = { id: "x", ...l.business };
  const d = await generateDraft({
    settings, business, findings: l.findings, offer: l.offer, contacts: l.contacts.map((c: any) => ({ business_id: "x", ...c })),
    steeringNote: null, purpose,
  }, call);
  out.push(`## ${l.business.name} (${l.offer})\nTo: ${d.to_contact_id ?? "—"} (${d.recipient_reason})\n`);
  d.variants.forEach((v, n) => {
    const checks = {
      variantCount: d.variants.length >= 1,
      underLimit: wordCount(v.body) <= MAX_WORDS,
      noFooterInBody: !v.body.includes(settings.physical_address) && !v.body.includes(settings.opt_out_line),
      noJargon: !JARGON.test(v.body),
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failures++;
    const e = composeEmail(settings, { subject: v.subject, body: v.body, include_footer: true });
    out.push(`### Variant ${n + 1}: ${v.angle || "(no angle)"} ${ok ? "PASS" : "FAIL " + JSON.stringify(checks)} (${wordCount(v.body)} words)\nSubject: ${v.subject}\n\n${e.text}\n`);
  });
}
mkdirSync("scripts/out", { recursive: true });
writeFileSync(`scripts/out/prompt-check-${purpose}.md`, out.join("\n"));
console.log(out.join("\n"));
console.log(failures ? `\n${failures} variant(s) failed checks` : "\nAll variants passed checks");
process.exit(failures ? 1 : 0);
