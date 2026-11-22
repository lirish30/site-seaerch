// The four mails of the retention ladder (Plan 15): fixed words, nothing written by a model. No price, no result, no promise: a thank-you and a plain ask.
import type { LadderStep } from "../db/ladder";

export type LadderMailStep = Extract<LadderStep, "review_request" | "testimonial" | "check_in" | "december_letter">;
export const LADDER_MAIL_STEPS: readonly LadderStep[] = ["review_request", "testimonial", "check_in", "december_letter"];
export const isLadderMailStep = (s: LadderStep): s is LadderMailStep => (LADDER_MAIL_STEPS as readonly string[]).includes(s);

export interface LadderMailInput {
  contactName: string; yourName: string; link: string | null; year: number;
  /** One optional line of the owner's own, shown only in the December letter, as a paragraph by itself. */
  personalLine: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** The one referral sentence the check-in carries; every client reads the same words. */
export const REFERRAL_SENTENCE = "If you know another business owner who could use a website, I would be glad to hear about them.";
/** The most of the personal line the letter shows. */
export const PERSONAL_LINE_MAX = 600;

/** The fixed mail for `step`. What a person typed (the contact's name, the sender's name, the personal line) is shown on one line and capped; the sender escapes it. */
export function ladderMail(step: LadderMailStep, c: LadderMailInput): { subject: string; body: string } {
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const hello = first ? `Hi ${first},` : "Hi,";
  const close = ["Thanks,", oneLine(c.yourName)].filter(Boolean).join("\n");
  const personal = oneLine(c.personalLine).slice(0, PERSONAL_LINE_MAX);
  const parts: { subject: string; paragraphs: string[] } = (() => {
    switch (step) {
      case "review_request": return {
        subject: "Would you leave a quick review?",
        paragraphs: [
          "Your new website is live, and it has been a pleasure working on it with you.",
          "If you have two minutes, a short Google review helps other people find you and trust you. A sentence or two in your own words is plenty.",
          ...(c.link ? [c.link] : []),
        ],
      };
      case "testimonial": return {
        subject: "A few words about working together?",
        paragraphs: [
          "I hope the site is treating you well.",
          "Would you be willing to share a few words about what it was like to work together? Just reply to this email with a sentence or two.",
          "If I may use them on my website, please say so, and tell me how you would like your name shown.",
        ],
      };
      case "check_in": return {
        subject: "Checking in on your website",
        paragraphs: [
          "It has been a few months since your site went live, so I wanted to check in.",
          "How is it working for you? If anything needs a change, or something has come up that you would like to talk through, reply to this email and we will sort it out.",
          REFERRAL_SENTENCE,
        ],
      };
      case "december_letter": return {
        subject: `A note at the end of ${c.year}`,
        paragraphs: [
          `As ${c.year} comes to a close, I wanted to say thank you for working with me this year. It means a lot.`,
          ...(personal ? [personal] : []),
          `If anything about your website needs attention in ${c.year + 1}, reply to this email and I will take care of it.`,
          "Wishing you a good holiday season.",
        ],
      };
    }
  })();
  return { subject: parts.subject, body: [hello, ...parts.paragraphs, close].join("\n\n") };
}

/** What each step is called in an approval's title and on the timeline. */
export const LADDER_STEP_TITLE: Record<LadderStep, string> = {
  review_request: "Review request", testimonial: "Testimonial request", thank_you: "Thank-you package", check_in: "Check-in", case_study: "Case study post", december_letter: "December letter",
};
