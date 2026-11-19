import type { PackageKey } from "../db/packages";
import { BUILD_KEYS } from "../documents/schedule";
import type { ItemKind, NewItem, OnboardingKind } from "../db/onboardings";

/** The questions and the things a client is asked to send, and the checks on what they type. Pure: no database, no clock. */

export interface Question {
  id: string; label: string; help?: string; type: "short" | "long" | "choice"; options?: string[]; required: boolean; kinds: OnboardingKind[];
}

const BOTH: OnboardingKind[] = ["build", "light"], BUILD: OnboardingKind[] = ["build"];

/** The first six go to every client; the rest are for site builds. The order is the order the form shows them. */
export const QUESTIONS: Question[] = [
  { id: "business", label: "What does your business do, and who do you do it for?", help: "Two or three sentences, as you would explain it to a new neighbor.", type: "long", required: true, kinds: BOTH },
  { id: "top_services", label: "Which three services make you the most money?", help: "Put the biggest first. Your best sellers are the ones the site should push.", type: "long", required: true, kinds: BOTH },
  { id: "service_area", label: "Where do you work?", help: "Cities, counties or a radius from your shop.", type: "short", required: true, kinds: BOTH },
  { id: "different", label: "What makes you different from the other shops in your area?", help: "Think about why customers pick you and why they come back.", type: "long", required: true, kinds: BOTH },
  { id: "sites_you_like", label: "Name three websites you like, and say what you like about each.", help: "They do not have to be in your industry. A link and a few words each is plenty.", type: "long", required: true, kinds: BOTH },
  { id: "voice_words", label: "Which three or four words should the site sound like?", help: "For example: friendly, plain-spoken, careful, fast.", type: "short", required: true, kinds: BOTH },
  { id: "brand_assets", label: "Do you already have a logo and brand colors?", type: "choice", options: ["Yes, both", "A logo only", "Colors only", "No, I have neither"], required: true, kinds: BUILD },
  { id: "brand_notes", label: "Any colors or styles you love or want to avoid?", type: "short", required: false, kinds: BUILD },
  { id: "who_updates", label: "Who will update the site after it launches?", type: "choice", options: ["I will", "Someone on my team", "I would like you to do it", "I am not sure yet"], required: true, kinds: BUILD },
  { id: "avoid", label: "Is there anything you do not want on the site?", help: "A word, a photo style, a service you no longer offer, a competitor you do not want to look like.", type: "long", required: false, kinds: BUILD },
  { id: "customer_questions", label: "What do customers ask you most before they hire you?", help: "These make good answers for the site itself.", type: "long", required: false, kinds: BUILD },
  { id: "launch_date", label: "Is there a date the site has to be live by?", help: "Leave this blank if there is no deadline.", type: "short", required: false, kinds: BUILD },
  { id: "contact_times", label: "When is the best time to reach you?", help: "Days and hours, and whether you prefer a call, a text or an email.", type: "short", required: true, kinds: BUILD },
  { id: "domain_owner", label: "Who registered your domain name?", help: "A name only, such as the company or person you paid. Do not type any login or password.", type: "short", required: false, kinds: BUILD },
];

export interface ItemTemplate {
  key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; appliesTo: (keys: PackageKey[]) => boolean;
}

const isBuild = (keys: PackageKey[]) => keys.some((k) => BUILD_KEYS.includes(k));
const has = (k: PackageKey) => (keys: PackageKey[]) => keys.includes(k);

/** In the order they are asked. Phase 1 is what the design starts from; phase 2 is what fills it in. */
export const ITEM_TEMPLATES: ItemTemplate[] = [
  { key: "logo_files", label: "Logo files", kind: "files", phase: 1, appliesTo: isBuild,
    instructions: "Upload your logo. A vector file (SVG, AI, EPS or PDF) is best. If all you have is a PNG or JPG, send the largest one you can find." },
  { key: "brand_text", label: "Brand colors and fonts", kind: "text", phase: 1, appliesTo: isBuild,
    instructions: "Type your brand colors (hex codes if you have them, plain names if not) and any fonts you use. If you have none, write \"none\" and I will suggest some." },
  { key: "homepage_text", label: "Homepage text", kind: "text", phase: 1, appliesTo: isBuild,
    instructions: "Write what you would want a first-time visitor to read: who you are, what you do, where you work, and what you want them to do next. Rough notes are fine." },
  { key: "homepage_photos", label: "Homepage photos", kind: "files", phase: 1, appliesTo: isBuild,
    instructions: "Upload three to six photos of your real work, your shop or your truck. Photos from your own phone are fine if they are sharp and in good light." },
  { key: "service_page_text", label: "Text for your first service page", kind: "text", phase: 1, appliesTo: isBuild,
    instructions: "Pick your best-selling service. Describe what it is, who it is for, how it works, what it costs or how you price it, and what a customer should do to get started." },
  { key: "service_photos", label: "Photos for that service", kind: "files", phase: 1, appliesTo: isBuild,
    instructions: "Upload photos that show that service being done or finished, ideally with a before and after." },
  { key: "about_text", label: "About text", kind: "text", phase: 2, appliesTo: isBuild,
    instructions: "Tell your story: how you started, how long you have been at it, and what you care about. Add licenses, certifications or awards you hold." },
  { key: "team_photos", label: "Team photos", kind: "files", phase: 2, appliesTo: isBuild,
    instructions: "Upload a photo of you, and of anyone else who works with customers. Name each person in the file name." },
  { key: "reviews_text", label: "Customer reviews", kind: "text", phase: 2, appliesTo: isBuild,
    instructions: "Paste three to six reviews or kind notes from customers, with the first name and town of each person if they would not mind." },
  { key: "service_area_text", label: "Cities and areas you serve", kind: "text", phase: 2, appliesTo: has("growth_site"),
    instructions: "List every city, town or neighborhood you want to be found in. Mark the three most important ones, and add a line about what you do there." },
  { key: "extra_pages_text", label: "Text for your other pages", kind: "text", phase: 2, appliesTo: has("starter_site"),
    instructions: "Write a short description for each of the other pages on your site, such as contact or a second service. A paragraph each is enough." },
  { key: "faq_text", label: "Common questions and answers", kind: "text", phase: 2, appliesTo: isBuild,
    instructions: "List the questions customers ask you again and again, with your answer to each. Five to ten is a good number." },
  { key: "social_links_text", label: "Social media links", kind: "text", phase: 2, appliesTo: isBuild,
    instructions: "Paste the web address of each business page you want linked from the site (Facebook, Instagram, Google Business Profile and so on). Skip any you do not use." },
];

/** A site build when any of its keys is a build package; everything else (a quick fix, care alone) is a light onboarding. Unknown keys count for nothing. */
export const onboardingKindOf = (keys: PackageKey[]): OnboardingKind => (isBuild(keys) ? "build" : "light");

export const questionsFor = (kind: OnboardingKind): Question[] => QUESTIONS.filter((q) => q.kinds.includes(kind));

/** The checklist for these packages: none for a light onboarding, else every template that applies, in order. */
export function itemsFor(keys: PackageKey[]): NewItem[] {
  return ITEM_TEMPLATES.filter((t) => t.appliesTo(keys)).map(({ key, label, instructions, kind, phase }) => ({ key, label, instructions, kind, phase }));
}

const CAP = { short: 300, long: 3000 } as const;

/**
 * Text a client typed, made safe to store and show: C0 controls (except newline and tab), DEL, C1 controls and every format character (bidi overrides,
 * zero-width marks) removed, trimmed, then cut to `max` without leaving half of a surrogate pair.
 */
export function cleanText(s: string, max: number): string {
  let out = String(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").replace(/\p{Cf}/gu, "").trim();
  if (out.length > max) {
    out = out.slice(0, Math.max(0, max));
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out;
}

/** Whether the text reads like someone typing a login: "password: ...", "api key = ...". The answer is refused; the form says never to send these. */
export const looksLikeCredential = (s: string): boolean => /\b(pass(word|code|phrase)?|pwd|login|api[ _-]?key|secret|token)\s*[:=]/i.test(s);

/**
 * What is wrong with these answers, by question id only: a problem never repeats what the client typed. With `requireAll` (the submit) a required question
 * must have an answer; a saved draft need not. An answer for a question the kind does not ask is an unknown id.
 */
export function validateAnswers(kind: OnboardingKind, answers: Record<string, string>, o: { requireAll: boolean }): { problems: string[] } {
  const problems: string[] = [];
  const questions = new Map(questionsFor(kind).map((q) => [q.id, q] as const));
  for (const [id, raw] of Object.entries(answers)) {
    const q = questions.get(id);
    if (!q) { problems.push("An answer was sent for a question that is not on this form."); continue; }
    if (typeof raw !== "string") { problems.push(`${id}: the answer must be text.`); continue; }
    const text = cleanText(raw, raw.length);
    if (!text) continue; // blank: nothing to check (a missing required answer is reported below)
    if (q.type === "choice") {
      if (!q.options?.includes(text)) problems.push(`${id}: pick one of the choices shown.`);
    } else if (text.length > CAP[q.type]) {
      problems.push(`${id}: the answer is longer than ${CAP[q.type]} characters.`);
    } else if (looksLikeCredential(text)) {
      problems.push(`${id}: this looks like a login or password. Please never send those here; remove it.`);
    }
  }
  if (o.requireAll) {
    for (const q of questions.values()) {
      const a = answers[q.id];
      if (q.required && (typeof a !== "string" || !cleanText(a, a.length))) problems.push(`${q.id}: this question needs an answer.`);
    }
  }
  return { problems };
}
