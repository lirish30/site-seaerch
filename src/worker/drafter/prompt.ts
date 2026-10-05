import type { Business, Contact, CtaStyle, EmailLength, Finding, Offer, Settings, TonePreset } from "../types";
import { NICHES } from "../audit/rubrics";

export interface DraftInput {
  settings: Settings; business: Business; findings: Finding[]; offer: Offer; contacts: Contact[]; steeringNote: string | null;
  /** Findings the sender picked to lead with; when empty the most severe ones are used. */
  focus?: Finding[];
  /** Overrides the account-wide tone for this draft only. */
  tone?: TonePreset | null;
  niche?: string | null;
  valueProposition?: string | null;
  /** The lead's chosen point of contact, addressed by name. */
  poc?: { name: string; role: string | null } | null;
}

const OFFER_TEXT: Record<Offer, string> = {
  new_site: "a new, simple, mobile-friendly website",
  performance: "a speed and mobile fix for their existing site",
  care_plan: "ongoing website care: keeping content, links and updates current",
  seo_basics: "fixing the basics so Google and visitors can find, trust and use the site",
  conversion: "a conversion-focused refresh: clearer calls to action, easier contact and booking, and trust signals that turn visitors into customers",
};

export const TONES: Record<TonePreset, string> = {
  friendly_local: "Warm, plain-spoken neighbour: a local developer who noticed something and wants to help. Friendly, direct, no hype.",
  consultative: "Calm expert advisor: diagnose, explain the business impact, propose a clear plan. Confident but never pushy.",
  direct: "Brief and to the point: short sentences, no small talk, gets to the problem and the fix fast.",
  formal: "Professional and polished: courteous business correspondence, complete sentences, no slang.",
};

const LENGTH: Record<EmailLength, number> = { short: 120, medium: 180, long: 250 };

const CTA: Record<CtaStyle, string> = {
  mini_audit: "offer to send their free website audit report (a short PDF of everything found)",
  call: "ask for a short 10-minute call this week",
  reply: "ask a simple yes/no question they can answer by replying",
  proposal: "offer to send a short written proposal with options and prices",
};

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, important: 1, nice: 2 };

export function buildPrompt(i: DraftInput) {
  const s = i.settings;
  const tone = TONES[i.tone ?? s.tone_preset ?? "friendly_local"] ?? TONES.friendly_local;
  const maxWords = LENGTH[s.email_length ?? "short"] ?? 120;
  const cta = CTA[s.cta_style ?? "mini_audit"] ?? CTA.mini_audit;
  const system = `You write short, proposal-style cold emails for ${s.your_name || "a freelance web developer"}${s.business_name ? ` of ${s.business_name}` : ""}, a web developer.
About them: ${s.services_blurb || "Builds and maintains websites for small local businesses."}
Tone: ${tone}${s.tone_notes ? `\nTheir own voice notes: ${s.tone_notes}` : ""}

Structure the email as a mini proposal, in this order:
1. An opening line specific to this business (their name, what they do, or their town). Never a generic pleasantry like "I hope this finds you well".
2. What you noticed: 2-3 problems from the findings, in plain English, each tied to what it costs a business like theirs (missed calls, bookings, orders, enquiries, trust).
3. What you'd do: the offer, with 2-3 concrete things you would fix, drawn from the recommendations.
4. One call to action only: ${cta}.

Rules:
- Body under ${maxWords} words before the footer, plain text, no markdown, no bullet symbols.
- Use the evidence given; never claim anything that is not in the findings. You may acknowledge one strength if it helps credibility.
- Never use jargon such as LCP, CLS, Core Web Vitals, meta description, viewport, CTA, CRO or SEO acronyms.
- End the body with exactly these lines, copied verbatim:
${s.signature}
${s.physical_address}
${s.opt_out_line}
- Choose to_contact_id only from the contact ids listed. Use null if no email contact is suitable.
Return your answer by calling the write_email tool.`;

  const chosen = i.focus?.length ? i.focus
    : [...i.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.points - a.points).slice(0, 3);
  const line = (f: Finding) => `- ${f.evidence}${f.recommendation ? ` (fix: ${f.recommendation})` : ""}`;
  const niche = i.niche && NICHES[i.niche] ? NICHES[i.niche] : null;
  const contactLines = i.contacts.length
    ? i.contacts.map((c) => `${c.id}: ${c.value} (${c.type}${c.person_name ? `, ${c.person_name}` : ""}${c.role ? `, ${c.role}` : ""})`).join("\n")
    : "none";
  const user = `Business: ${i.business.name}
Category: ${i.business.category ?? "unknown"}${niche ? `\nIndustry: ${niche.label}; their website's job is ${niche.goal.toLowerCase()}` : ""}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website_url ?? "none"}${i.valueProposition ? `\nWhat their site says they do: ${i.valueProposition}` : ""}${i.poc ? `\nAddress the email to: ${i.poc.name}${i.poc.role ? ` (${i.poc.role})` : ""}` : ""}

${i.focus?.length ? "Lead with these issues (the sender chose them):" : "Findings (most important first):"}
${chosen.map(line).join("\n") || "- none"}

Offer to lead with: ${i.offer} — ${OFFER_TEXT[i.offer]}

Contacts:
${contactLines}${i.steeringNote ? `\n\nExtra instruction for this draft: ${i.steeringNote}` : ""}`;

  return { system, user };
}
