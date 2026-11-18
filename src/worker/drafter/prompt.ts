import type { Business, Contact, CtaStyle, EmailLength, Finding, Offer, Purpose, Settings, TonePreset } from "../types";
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
  /** Why the email is being written. Defaults to a freelance pitch. */
  purpose?: Purpose;
  /** Rewrite this draft with one change instead of writing fresh variants. */
  revise?: { subject: string; body: string; instruction: string };
}

/** How many differently-angled emails one call writes. */
export const VARIANT_COUNT = 3;

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


const FREELANCE_ANGLES = [
  "Problem-led: open on the costliest thing you noticed, then the fix.",
  "Offer-led: open on what you could do for them, backed by what you noticed.",
  "Question-led: open with a short, specific question about their site that invites a reply.",
];

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, important: 1, nice: 2 };

const chosenFindings = (i: DraftInput, n: number) => i.focus?.length ? i.focus
  : [...i.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.points - a.points).slice(0, n);
const findingLine = (f: Finding) => `- ${f.evidence}${f.recommendation ? ` (fix: ${f.recommendation})` : ""}`;
const contactLines = (i: DraftInput) => i.contacts.length
  ? i.contacts.map((c) => `${c.id}: ${c.value} (${c.type}${c.person_name ? `, ${c.person_name}` : ""}${c.role ? `, ${c.role}` : ""})`).join("\n")
  : "none";

const variantRules = (i: DraftInput, angles: string[]) => i.revise
  ? "Return exactly 1 variant: the revised draft."
  : `Write ${VARIANT_COUNT} variants, each taking a different angle, and label each with a short angle name:\n${angles.map((a, n) => `${n + 1}. ${a}`).join("\n")}`;

/** The draft being rewritten. It is shown as data: the model wrote it from a site's text, and the sender may have edited it. */
const currentDraftBlock = (i: DraftInput) => i.revise ? `\n\nCurrent draft to revise:\nSubject: ${i.revise.subject}\n\n${i.revise.body}` : "";
/** What the sender asked for this draft: their own words (the steering note) and, for a rewrite, the fixed change they picked. */
const directionLines = (i: DraftInput) => [
  i.steeringNote ? `Extra instruction for this draft: ${i.steeringNote}` : "",
  i.revise ? `Change requested: ${i.revise.instruction}\nKeep everything in it that is still true and wanted.` : "",
].filter(Boolean).join("\n\n");

const businessBlock = (i: DraftInput) => {
  const niche = i.niche && NICHES[i.niche] ? NICHES[i.niche] : null;
  return `Business: ${i.business.name}
Category: ${i.business.category ?? "unknown"}${niche ? `\nIndustry: ${niche.label}; their website's job is ${niche.goal.toLowerCase()}` : ""}
Location: ${i.business.address ?? "unknown"}
Website: ${i.business.website_url ?? "none"}${i.valueProposition ? `\nWhat their site says they do: ${i.valueProposition}` : ""}${i.poc ? `\nAddress the email to: ${i.poc.name}${i.poc.role ? ` (${i.poc.role})` : ""}` : ""}`;
};

export function buildFreelancePrompt(i: DraftInput) {
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
- Body under ${maxWords} words, plain text, no markdown, no bullet symbols.
- Use the evidence given; never claim anything that is not in the findings. You may acknowledge one strength if it helps credibility.
- Never use jargon such as LCP, CLS, Core Web Vitals, meta description, viewport, CTA, CRO or SEO acronyms.
- End with a short sign-off and just their first name. Do NOT write a full signature, address or opt-out line: those are added automatically.
- ${variantRules(i, FREELANCE_ANGLES)}
- Choose to_contact_id only from the contact ids listed. Use null if no email contact is suitable.
Return your answer as the task's result: an object with variants, to_contact_id and recipient_reason.`;

  // `facts` is everything copied from the lead's site or listing; `directions` is what the sender asked for. The queue shows them apart.
  const facts = `${businessBlock(i)}

${i.focus?.length ? "Lead with these issues (the sender chose them):" : "Findings (most important first):"}
${chosenFindings(i, 3).map(findingLine).join("\n") || "- none"}

Offer to lead with: ${i.offer} — ${OFFER_TEXT[i.offer]}

Contacts:
${contactLines(i)}${currentDraftBlock(i)}`;
  const directions = directionLines(i);
  return { system, facts, directions, user: directions ? `${facts}\n\n${directions}` : facts };
}

export function buildPrompt(i: DraftInput) {
  return buildFreelancePrompt(i);
}
