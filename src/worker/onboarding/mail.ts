import { parseSignature } from "../email/signature";
import type { Onboarding } from "../db/onboardings";
import { TERMS } from "../documents/clauses";
import type { Settings } from "../types";
import { QUESTIONNAIRE_DUE_DAYS, SILENCE_DAYS } from "./schedule";
import { cleanText } from "./templates";

/**
 * The mail an onboarding sends: fixed words for every client, plain text, one client link each. What a client or the owner typed (names, item labels, the
 * video link) is data: cleaned, put on one line, capped, and never allowed to carry the client link a second time. The sender builds the html from the body.
 */
export interface OnboardingMail { subject: string; body: string }

export interface MailCtx {
  clientName: string; contactName: string;
  /** When the client last wrote (UTC ISO), or the welcome's date before they have; names the day in the level 3 and 4 reminders. */
  lastClientActivityAt?: string | null;
  /** The owner's IANA zone, for that day; UTC when absent or unknown. */
  tz?: string;
}
export interface FridayCtx { clientName?: string; contactName?: string; waiting: string[]; received: string[]; questionnaireDone: boolean }

const NAME_MAX = 60, BUSINESS_MAX = 120, LABEL_MAX = 100, LIST_MAX = 12, URL_MAX = 300;
const DAY = 86_400_000;

/** Client text as one clean line, without a second copy of the client link. */
const line = (s: string, max: number, link: string) => cleanText(String(s ?? ""), 4 * max).split(link).join(" ").replace(/\s+/g, " ").trim().slice(0, max).trim();

function longDay(ms: number, tz: string | undefined): string {
  const fmt = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long", day: "numeric", year: "numeric" }).format(new Date(ms));
  try { return fmt(tz || "UTC"); } catch { return fmt("UTC"); }
}

/** The day the silence clause would apply, counted from the last word from the client; null when that is not known. */
function clauseDay(c: MailCtx): string | null {
  const t = c.lastClientActivityAt ? Date.parse(c.lastClientActivityAt) : NaN;
  return Number.isFinite(t) ? longDay(t + SILENCE_DAYS * DAY, c.tz) : null;
}

const NO_PASSWORDS = "Please never send passwords, by email or on that page. If I ever need access to something, I will tell you a safe way to share it.";

function frame(s: Settings, link: string, c: { contactName?: string }, paragraphs: string[]): string {
  const first = line(c.contactName ?? "", NAME_MAX, link).split(" ")[0];
  const sender = parseSignature(s.signature_json) || s.signature.trim() ? "" : line(s.your_name, NAME_MAX, link);
  return [first ? `Hi ${first},` : "Hi,", ...paragraphs, ["Thanks,", sender].filter(Boolean).join("\n")].join("\n\n");
}

export function renderWelcome(o: Onboarding, c: { clientName: string; contactName: string }, link: string, s: Settings): OnboardingMail {
  const biz = line(c.clientName, BUSINESS_MAX, link);
  const video = o.welcomeVideoUrl ? line(o.welcomeVideoUrl, URL_MAX, link) : "";
  const next = o.kind === "build"
    ? `Please fill in the questionnaire within ${QUESTIONNAIRE_DUE_DAYS} days. It is how I learn about your business, your customers and the look you want. After that, the same page lists the logo, photos and text I need, each with a date. Send what you have. Rough is fine.`
    : `Please fill in the short questionnaire within ${QUESTIONNAIRE_DUE_DAYS} days. It is the only thing I need from you for now.`;
  const body = frame(s, link, c, [
    `Welcome${biz ? `, and thank you for choosing me for ${biz}` : ""}. Everything we need from you is on one page that saves as you go, so you can stop and come back whenever you like.`,
    ...(video ? [`I recorded a short hello for you first:\n${video}`] : []),
    `Your page:\n${link}`,
    next,
    NO_PASSWORDS,
    "Reply to this email if you have a question.",
  ]);
  return { subject: "Welcome. Here is how we get started", body };
}

/** A reminder that gets firmer with the level. Levels 3 and 4 name the day the contract's silence clause would apply. */
export function renderReminder(level: 1 | 2 | 3 | 4, c: MailCtx, link: string, s: Settings): OnboardingMail {
  const biz = line(c.clientName, BUSINESS_MAX, link) || "your project";
  const day = clauseDay(c);
  const make = (subject: string, paragraphs: string[]): OnboardingMail => ({ subject, body: frame(s, link, c, [...paragraphs, NO_PASSWORDS, "Reply to this email if you are stuck or have a question."]) });
  switch (level) {
    case 1:
      return make("A quick nudge about your site", [
        `I have not heard from you in a couple of days. When you have a few minutes, open your page and pick up where you left off. It saves as you go, so a partial answer still helps.\n${link}`,
      ]);
    case 2:
      return make("Your site is waiting on a few things", [
        `${biz} is waiting on a few things from you, and I cannot move the work forward without them. Your page shows what is still open:\n${link}`,
        "If one of them is hard to find or you are not sure what I mean, tell me which one and I will help.",
      ]);
    case 3:
      return make("Your project may move back in my schedule", [
        `It has been a week or more since I last heard from you. I hold a place in my schedule for ${biz} only while we are in touch. ${day
          ? `If I hear nothing by ${day}, the project goes to the back of the queue, as the agreement says.`
          : `If I hear nothing for ${SILENCE_DAYS} days in a row, the project goes to the back of the queue, as the agreement says.`} Any answer or file on your page before then keeps your place.\n${link}`,
      ]);
    case 4:
      return make("Last reminder before your project moves back", [
        `Your agreement says that if I hear nothing for ${SILENCE_DAYS} days after asking for your content, the project goes to the back of the queue. In plain words: I would stop work, give that time to other clients, and restart yours when I have a free slot.${day ? ` For ${biz}, that day is ${day}.` : ""}`,
        `Nothing you have already sent is lost. Any answer or file on your page starts the count again. The agreement also lets me re-quote a project that has waited more than ${TERMS.requoteMonths} months.\n${link}`,
      ]);
  }
}

/** The Friday summary: what has come in, what is still open, and whether the questionnaire is done. */
export function renderFriday(c: FridayCtx, link: string, s: Settings): OnboardingMail {
  const list = (labels: string[]) => {
    const shown = labels.map((l) => line(l, LABEL_MAX, link)).filter(Boolean);
    return [...shown.slice(0, LIST_MAX).map((l) => `- ${l}`), ...(shown.length > LIST_MAX ? [`and ${shown.length - LIST_MAX} more`] : [])].join("\n");
  };
  const biz = line(c.clientName ?? "", BUSINESS_MAX, link);
  const parts = [`Here is where things stand${biz ? ` for ${biz}` : ""} as the week ends.`];
  parts.push(c.questionnaireDone ? "Your questionnaire is in. Thank you." : "Your questionnaire is not in yet. It is the first thing I need.");
  if (c.received.length) parts.push(`I have received:\n${list(c.received)}`);
  if (c.waiting.length) parts.push(`Still open:\n${list(c.waiting)}`);
  else if (c.questionnaireDone) parts.push("Nothing else is open right now.");
  parts.push(`Pick up where you left off here. It saves as you go.\n${link}`, NO_PASSWORDS, "Reply to this email if you are stuck or have a question.");
  return { subject: "Where your site stands this week", body: frame(s, link, c, parts) };
}
