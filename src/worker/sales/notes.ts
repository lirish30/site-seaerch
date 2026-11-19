import { z } from "zod";

/**
 * What Logan writes down on the discovery call (Web Kit section 8): the owner's answers to the ten questions in their own words, up to three goals, up
 * to three things about where they are now, and the two numbers the owner gave. A number the owner did not give is `null` and stays `null`: it is never
 * estimated (Web Kit section 9, "Use only numbers the owner gave you").
 */
export interface DiscoveryNotes {
  answers: { n: number; text: string }[];
  goals: string[];
  currentState: string[];
  /** What an average job is worth to them, in cents. */
  avgJobValueCents: number | null;
  /** Jobs they say they miss in a month. */
  missedJobsPerMonth: number | null;
  /** Decides which packages may be offered: Care is for WordPress sites only. */
  platform: "wordpress" | "other";
  decisionMakers: string;
  /** When Logan marked the call done. Set by the server, never by the notes form. */
  callHeldAt: string | null;
}

const isDate = (s: string) => Number.isFinite(Date.parse(s));

export const DiscoveryNotesSchema = z.object({
  answers: z.array(z.object({ n: z.number().int().min(1).max(10), text: z.string().trim().max(2000) }).strict()).max(10)
    .refine((a) => new Set(a.map((x) => x.n)).size === a.length, "Each question has one answer"),
  goals: z.array(z.string().trim().min(1).max(200)).max(3),
  currentState: z.array(z.string().trim().min(1).max(200)).max(3),
  avgJobValueCents: z.number().int().min(0).max(10_000_000).nullable(),
  missedJobsPerMonth: z.number().int().min(0).max(1000).nullable(),
  platform: z.enum(["wordpress", "other"]),
  decisionMakers: z.string().trim().max(300),
  callHeldAt: z.string().max(40).refine(isDate, "Not a date").nullable(),
}).strict() satisfies z.ZodType<DiscoveryNotes>;

/** A blank set of notes. The platform starts as "other" (the cautious answer: Care is not offered until Logan says the site is WordPress). */
export const emptyNotes = (): DiscoveryNotes => ({
  answers: [], goals: [], currentState: [], avgJobValueCents: null, missedJobsPerMonth: null, platform: "other", decisionMakers: "", callHeldAt: null,
});

/** Whether Logan wrote an answer. A recap is built from the owner's words, so notes with none are the same as no notes. */
export const hasNotes = (n: DiscoveryNotes | null): boolean => n !== null && n.answers.some((a) => a.text.trim() !== "");

/**
 * What the owner says they lose each month: missed jobs times what a job is worth. Only when both numbers are given and above zero, else `null`. Never
 * a guess, so a missing input leaves the figure out of the deck.
 */
export function monthlyAtStakeCents(n: DiscoveryNotes): number | null {
  const { avgJobValueCents: job, missedJobsPerMonth: missed } = n;
  return job !== null && missed !== null && job > 0 && missed > 0 ? job * missed : null;
}

/** The kind of lead a recap names (Web Kit pitch deck, slide 19). It decides which slides and which options fit. */
export type LeadType = "wp_few_broken" | "wp_behind" | "other_platform" | "more_calls" | "new_site";
export const LEAD_TYPES: readonly LeadType[] = ["wp_few_broken", "wp_behind", "other_platform", "more_calls", "new_site"];

/** Slide 19's table in words, for the recap instructions: the lead type, who it is, and what usually fits (a starting point, never a rule). */
export const LEAD_TYPE_GUIDE: { type: LeadType; lead: string; usuallyFits: string }[] = [
  { type: "wp_few_broken", lead: "WordPress site, a few things broken", usuallyFits: "Quick Fix and Care" },
  { type: "wp_behind", lead: "WordPress site years behind on updates", usuallyFits: "Care first, then Quick Fix" },
  { type: "other_platform", lead: "Wix, Squarespace, or GoDaddy site", usuallyFits: "Quick Fix, maybe Local SEO (no Care: Care is for WordPress only)" },
  { type: "more_calls", lead: "Wants more calls from Google", usuallyFits: "Care and Local SEO" },
  { type: "new_site", lead: "Under construction or rented platform", usuallyFits: "Starter Site or Website Subscription" },
];
