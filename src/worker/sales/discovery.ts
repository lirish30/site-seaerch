import { formatPrice } from "../../client/packagesView";
import { PACKAGE_KEYS, type Package } from "../db/packages";

/** The 20-minute discovery call (Web Kit section 8). It is fixed: call prep tailors it and never replaces it. */
export const DISCOVERY_STRUCTURE: { fromMin: number; toMin: number; title: string; detail: string }[] = [
  { fromMin: 0, toMin: 3, title: "Rapport", detail: "Thanks, a bit of rapport, confirm you have 20 minutes." },
  { fromMin: 3, toMin: 13, title: "Ask the questions", detail: "Write their exact words; they go on slide 3 of the deck." },
  { fromMin: 13, toMin: 17, title: "Play it back", detail: "Play back what you heard in two or three sentences. Ask if you got it right." },
  { fromMin: 17, toMin: 20, title: "Book the recommendation meeting", detail: "Book the recommendation meeting before you hang up. Offer two specific times." },
];

/** The ten discovery questions, word for word from the Web Kit. Index 0 to 9; a question's number in code and on screen is its index plus one. */
export const DISCOVERY_QUESTIONS: string[] = [
  "What services make you the most money, and which ones do you want more of?",
  "Which towns do you want customers from?",
  "How do most new customers find you today?",
  "Roughly what's an average job worth?",
  "How many more jobs a month could you handle right now?",
  "Who looks after the website today, and is it on WordPress, Wix, or something else?",
  "Have you worked with a web person or agency before? How did it go?",
  "What would make this worth it to you a year from now?",
  "Is anyone else involved in deciding? Who should be on the next call?",
  "What would stop you from moving ahead if the plan made sense?",
];

/**
 * The six common objections (Web Kit section 10), in Logan's words. A price is never written here: it is a `{{package_key}}` merge field, filled from the
 * package catalog by `mergePrices`, so a price change in Settings is the only place a price changes.
 */
export const BASE_PUSHBACKS: { objection: string; answer: string }[] = [
  { objection: "That's more than I expected.",
    answer: "That's fair. The Quick Fix on its own is {{quick_fix}} and fixes what's in the video. Care is optional ({{care}}). We can start there and you can decide on the rest later." },
  { objection: "Someone else will do it cheaper.",
    answer: "Probably. What you get here is one person who does the work, a flat price, and a video showing what changed. If someone else is a better fit, the video still helps them." },
  { objection: "You don't know my industry.",
    answer: "What I look at is the same for every local business: can people call you, do you look open, and does Google know what you do and where. You know the work; I'll ask you about it." },
  { objection: "We have an SEO company.",
    answer: "Good. If you're seeing results, keep them. If you're not sure what they're doing, I'm happy to give you a second opinion on the site." },
  { objection: "I've been burned before.",
    answer: "That happens a lot, and it's why I list prices up front and send a video of every change. You'll always know what I did." },
  { objection: "Will this get me to the top of Google?",
    answer: "No, and I'd be careful with anyone who promises that. The work removes what makes it harder for Google to understand what you do and where." },
];

const MERGE_FIELD = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Replaces each `{{<package key>}}` with that package's price as the catalog shows it ("$797", "$129/mo"). A field that is not a package key, or whose
 * package the catalog does not hold, throws: a price is never guessed.
 */
export function mergePrices(text: string, catalog: Package[]): string {
  return text.replace(MERGE_FIELD, (_all, key: string) => {
    const pkg = (PACKAGE_KEYS as readonly string[]).includes(key) ? catalog.find((p) => p.key === key) : undefined;
    if (!pkg) throw new Error(`unknown price field {{${key}}}`);
    return formatPrice(pkg);
  });
}
