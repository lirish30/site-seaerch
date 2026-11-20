import { CONSENT_LABEL, ESIGN_DISCLOSURE } from "../worker/documents/consent";
import { dollars } from "./packagesView";
import { nameProblem } from "./proposalPageView";
import type { PublicChangeOrder } from "../worker/changeorders/public";

/** Pure helpers for the client's change-order page (`/c/<token>`). Plain values in, plain text out: no DOM, no fetch, no clock. */

export type { PublicChangeOrder };
export type ClosedReason = PublicChangeOrder["closedReason"];

/** "1.5 hours × $95 an hour = $142.50". The price is the order's own (a custom price wins over hours times rate). */
export function priceLine(hours: number, rateCents: number, priceCents: number): string {
  return `${hours} ${hours === 1 ? "hour" : "hours"} × ${dollars(rateCents)} an hour = ${dollars(priceCents)}`;
}

/** What the change does to the schedule, in a sentence. Nothing known is the same as no change. */
export function scheduleLine(days: number | null): string {
  if (!days) return "No change to the schedule.";
  return `Adds ${days} ${days === 1 ? "day" : "days"} to the schedule.`;
}

/** Everything still needed before "Sign" works, in the order the page asks for it. `ok` is true exactly when nothing is missing. */
export function canSign(f: { name: string; consent: boolean; authority: boolean }): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!f.consent) missing.push("Tick the box to agree to sign electronically.");
  if (!f.authority) missing.push("Confirm you can sign for the business.");
  const name = nameProblem(f.name);
  if (name) missing.push(name);
  return { ok: missing.length === 0, missing };
}

/** The sentence under "This change order is closed", for each way an order closes. */
export function closedMessage(reason: ClosedReason): string {
  switch (reason) {
    case "void": return "This change order was withdrawn, so it can't be signed. Reply to the email you got if you have a question.";
    case "expired": return "This change order has expired, so it can't be signed any more. Reply to the email you got and we'll send a new one.";
    case "declined": return "You said no thanks to this change order. Nothing will be done and nothing is owed. If you change your mind, reply to the email you got.";
    default: return "This change order isn't open any more, so it can't be signed. Reply to the email you got and we'll sort it out.";
  }
}

/** What the page says when a sign attempt fails. Nothing the server sent is shown. */
export function signError(status: number): string {
  switch (status) {
    case 400: return "Check your name and both boxes, then try again.";
    case 404: return "This link is no longer available.";
    case 409: return "This change order changed or is no longer open. We've reloaded it: read it again before you sign.";
    case 413: return "That name is too long. Check it and try again.";
    case 429: return "Too many tries. Wait a minute and try again.";
    case 0: return "We couldn't reach the server. Check your connection and try again.";
    default: return "Something went wrong on our side. Please try again.";
  }
}

/** What the page says when "No thanks" fails. Nothing the server sent is shown. */
export function declineError(status: number): string {
  switch (status) {
    case 404: return "This link is no longer available.";
    case 409: return "This change order is no longer open, so there's nothing to turn down. We've reloaded it.";
    case 413: return "That note is too long. Shorten it and try again.";
    case 429: return "Too many tries. Wait a minute and try again.";
    case 0: return "We couldn't reach the server. Check your connection and try again.";
    default: return "Something went wrong on our side. Please try again.";
  }
}

/**
 * The stored consent text as what the page shows: the disclosure to read and the two labels to tick. The text is the disclosure, the consent label, then the authority label (which
 * holds the client's name, and so may hold anything), so it is matched against the constants it was built from and never guessed at by splitting: what follows the known prefix is the
 * authority label whole. Text that does not start that way (an older version, or a different one) is shown whole as the disclosure, with plain labels.
 */
export function splitConsent(consentText: string): { disclosure: string[]; consentLabel: string; authorityLabel: string } {
  const prefix = `${ESIGN_DISCLOSURE}\n\n${CONSENT_LABEL}\n\n`;
  if (consentText.startsWith(prefix) && consentText.length > prefix.length) {
    return { disclosure: ESIGN_DISCLOSURE.split(/\n{2,}/), consentLabel: CONSENT_LABEL, authorityLabel: consentText.slice(prefix.length) };
  }
  return { disclosure: consentText.split(/\n{2,}/).filter((p) => p.trim()), consentLabel: "I agree to use electronic records and signatures.", authorityLabel: "I am authorized to sign for the business named in this document." };
}
