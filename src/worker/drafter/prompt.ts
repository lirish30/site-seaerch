import type { Business, Contact, CtaStyle, EmailLength, Finding, Offer, Purpose, Settings, TonePreset, WorkSample } from "../types";
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
  /** The work the sender may cite; the model must not mention any other. */
  samples?: WorkSample[];
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


const FULL_TIME_TONES: Record<TonePreset, string> = {
  friendly_local: "Warm and genuine, like a thoughtful note from a peer who did their homework. Human, never salesy.",
  consultative: "Confident and thoughtful, a craftsperson explaining how they would approach a real problem.",
  direct: "Brief and plain: short sentences, no filler, respectful of their time.",
  formal: "Professional and polished: courteous, complete sentences, no slang.",
};
const FULL_TIME_LENGTH: Record<EmailLength, number> = { short: 150, medium: 210, long: 280 };

const FULL_TIME_ANGLES = [
  "Intro-led: open on who you are and why this company, then one nod to their site, then your work.",
  "Work-led: open on your most relevant sample, then say why that made you look at this company.",
  "Short and direct: three or four sentences, who you are, one specific nod, one link, a low-pressure ask.",
];
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

const reviseBlock = (i: DraftInput) => i.revise
  ? `\n\nCurrent draft to revise:\nSubject: ${i.revise.subject}\n\n${i.revise.body}\n\nChange requested: ${i.revise.instruction}\nKeep everything in it that is still true and wanted.` : "";

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
Return your answer by calling the write_email tool.`;

  const user = `${businessBlock(i)}

${i.focus?.length ? "Lead with these issues (the sender chose them):" : "Findings (most important first):"}
${chosenFindings(i, 3).map(findingLine).join("\n") || "- none"}

Offer to lead with: ${i.offer} — ${OFFER_TEXT[i.offer]}

Contacts:
${contactLines(i)}${i.steeringNote ? `\n\nExtra instruction for this draft: ${i.steeringNote}` : ""}${reviseBlock(i)}`;

  return { system, user };
}

export function buildFullTimePrompt(i: DraftInput) {
  const s = i.settings;
  const tone = FULL_TIME_TONES[i.tone ?? s.tone_preset ?? "friendly_local"] ?? FULL_TIME_TONES.friendly_local;
  const maxWords = FULL_TIME_LENGTH[s.email_length ?? "short"] ?? 150;
  const about = s.bio || s.services_blurb || "A web professional.";
  const system = `You write personal outreach emails for ${s.your_name || "a web professional"}${s.role_title ? `, ${s.role_title}` : ""}, who is looking for a full-time role.
${s.goal_line ? `What they are looking for: ${s.goal_line}\n` : ""}About them: ${about}${s.availability ? `\nAvailability: ${s.availability}` : ""}
Tone: ${tone}${s.tone_notes ? `\nTheir own voice notes: ${s.tone_notes}` : ""}

This is a speculative introduction from a person to a person. The company has not necessarily posted a role, so never pretend one is open and never say "I saw your job posting". The email is about the SENDER and why they would be a good addition to this team. It is not a website review and not a sales pitch. If it could be sent to a prospective client unchanged, it is wrong.

Write it in this order:
1. Open with who they are and why this company: one or two sentences that say what kind of developer they are and what drew them to this company specifically (what the company does, their town, or what their site says they do). Lead with the person, never with a problem on the site.
2. One light nod to the site, in a single sentence: something specific from the findings that shows they really looked, said with respect for the people who built it. Plain words, at most one concrete detail. NO list of issues, NO fix steps, NO "I would start by", NO offer to fix or to talk about the issue, and no claims about how or on what device they looked unless a finding says so. Do not praise anything the findings do not show (no "clearly well built", no "everything else is great").
3. What they would bring: tie the kind of work they do (from the brief about them) to a company like this one. Cite 1-2 of the work samples listed below by name with their link and the result in a short phrase. If none are listed, cite no work and say they are happy to share examples.
4. A soft, low-pressure ask for a short conversation about whether there is a place for someone like them now or later.${s.resume_url ? ` Include their resume link: ${s.resume_url}` : ""}

Rules:
- Body under ${maxWords} words, plain text, no markdown, no bullet symbols. Paste links as plain URLs.
- Only state facts from this brief. Never invent employers, years of experience, numbers, tools, awards or results, and never cite work that is not listed. Never say how the sender found the company (no "I came across", "I stumbled on", "I was looking at") and never invent why the sender picked this company beyond what the company does, its town, or what its site says. If the brief about them is thin, write a shorter, honest email instead of filling space.
- Never use jargon such as LCP, CLS, Core Web Vitals, meta description, viewport, CTA, CRO or SEO acronyms.
- Do not beg or over-apologise, and do not ask for a job in the first line.
- End with a short sign-off and just their first name. Do NOT write a full signature, address or opt-out line: those are added automatically.
- ${variantRules(i, FULL_TIME_ANGLES)}
- Choose to_contact_id only from the contact ids listed. Prefer a founder, owner or hiring lead over a generic inbox. Use null if no email contact is suitable.
Return your answer by calling the write_email tool.`;

  const samples = i.samples?.length
    ? i.samples.map((w) => `- ${w.title}: ${w.url}${w.result_line ? ` (${w.result_line})` : ""}`).join("\n")
    : "none";
  const user = `${businessBlock(i)}

${i.focus?.length ? "Something noticed on their site (the sender chose these; use one):" : "Things noticed on their site (use at most one, for the single nod):"}
${chosenFindings(i, 3).map((f) => `- ${f.evidence}`).join("\n") || "- none"}

Work samples you may cite (only these):
${samples}

Contacts:
${contactLines(i)}${i.steeringNote ? `\n\nExtra instruction for this draft: ${i.steeringNote}` : ""}${reviseBlock(i)}`;

  return { system, user };
}

export function buildPrompt(i: DraftInput) {
  return i.purpose === "full_time" ? buildFullTimePrompt(i) : buildFreelancePrompt(i);
}
