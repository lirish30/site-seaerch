import type { Business, Contact, Finding, Offer, Settings } from "../types";

export interface DraftInput {
  settings: Settings; business: Business; findings: Finding[]; offer: Offer; contacts: Contact[]; steeringNote: string | null;
}

const OFFER_TEXT: Record<Offer, string> = {
  new_site: "a new, simple, mobile-friendly website",
  performance: "a speed and mobile fix for their existing site",
  care_plan: "ongoing website care: keeping content, links and updates current",
  seo_basics: "fixing the basics so Google and visitors can find, trust and use the site",
};

export function buildPrompt(i: DraftInput) {
  const s = i.settings;
  const system = `You write short cold emails for ${s.your_name || "a freelance web developer"}${s.business_name ? ` of ${s.business_name}` : ""}, a local web developer.
About them: ${s.services_blurb || "Builds and maintains websites for small local businesses."}
Voice: ${s.tone_notes || "Plain, friendly, direct. No hype."}

Rules:
- Body under 120 words, plain text, no markdown, no bullet symbols.
- Open with something specific to this business (their name, trade, or town), never a generic pleasantry like "I hope this finds you well".
- Mention at most 3 problems, in plain English, using the evidence given. Never use jargon such as LCP, CLS, Core Web Vitals, meta description, viewport, or SEO acronyms.
- Do not claim anything that is not in the findings provided.
- One call to action only: offer a free 5-minute mini-audit or a short call.
- End the body with exactly these lines, copied verbatim:
${s.signature}
${s.physical_address}
${s.opt_out_line}
- Choose to_contact_id only from the contact ids listed. Use null if no email contact is suitable.
Return your answer by calling the write_email tool.`;

  const top = [...i.findings].sort((a, b) => b.points - a.points).slice(0, 3);
  const contactLines = i.contacts.length
    ? i.contacts.map((c) => `${c.id}: ${c.value} (${c.type}${c.person_name ? `, ${c.person_name}` : ""}${c.role ? `, ${c.role}` : ""})`).join("\n")
    : "none";
  const user = `Business: ${i.business.name}
Category: ${i.business.category ?? "unknown"}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website_url ?? "none"}

Findings (most important first):
${top.map((f) => `- ${f.evidence}`).join("\n") || "- none"}

Offer to lead with: ${i.offer} — ${OFFER_TEXT[i.offer]}

Contacts:
${contactLines}${i.steeringNote ? `\n\nExtra instruction for this draft: ${i.steeringNote}` : ""}`;

  return { system, user };
}
