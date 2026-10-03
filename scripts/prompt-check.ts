import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateDraft, anthropicCaller, wordCount } from "../src/worker/drafter/draft";
import type { Settings } from "../src/worker/types";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }

const settings: Settings = {
  your_name: "Logan Irish", business_name: process.env.BIZ_NAME ?? "Logan Irish Web", contact_email: "",
  services_blurb: "I build, speed up, and look after websites for small local businesses.",
  signature: "Logan Irish", physical_address: process.env.ADDRESS ?? "123 Main St, Boise, ID 83702",
  opt_out_line: "If you'd rather not hear from me, just reply \"no thanks\" and I won't follow up.",
  tone_notes: process.env.TONE ?? "", monthly_spend_limit_usd: 25, logo_url: "",
};
const JARGON = /\b(LCP|CLS|Core Web Vitals|meta description|viewport|SEO)\b/i;
const leads = JSON.parse(readFileSync("scripts/fixtures/leads.json", "utf8"));
const call = anthropicCaller(key);
let failures = 0; const out: string[] = [];

for (const l of leads) {
  const d = await generateDraft({ settings, business: { id: "x", ...l.business }, findings: l.findings, offer: l.offer, contacts: l.contacts.map((c: any) => ({ business_id: "x", ...c })), steeringNote: null }, call);
  const bodyNoFooter = d.body.replace(settings.signature, "").replace(settings.physical_address, "").replace(settings.opt_out_line, "");
  const checks = {
    under120: wordCount(bodyNoFooter) < 120,
    address: d.body.includes(settings.physical_address),
    optOut: d.body.includes(settings.opt_out_line),
    noJargon: !JARGON.test(d.body),
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) failures++;
  out.push(`## ${l.business.name} (${l.offer}) ${ok ? "PASS" : "FAIL " + JSON.stringify(checks)}\nTo: ${d.to_contact_id ?? "—"} (${d.recipient_reason})\nSubject: ${d.subject}\n\n${d.body}\n`);
}
mkdirSync("scripts/out", { recursive: true });
writeFileSync("scripts/out/prompt-check.md", out.join("\n---\n\n"));
console.log(out.join("\n---\n\n"));
console.log(failures ? `\n${failures} draft(s) failed checks` : "\nAll drafts passed checks");
process.exit(failures ? 1 : 0);
