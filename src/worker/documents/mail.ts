import { dollars } from "../../client/packagesView";
import { guestLinkBase } from "../booking/mail";
import { parseSignature } from "../email/signature";
import type { Env } from "../env";
import type { Settings } from "../types";
import type { ProposalContent } from "./proposal";

/** What the mail is: a one-line subject and a plain-text body. The sender builds the html from the body (escaping it) and adds the signature block. */
export interface ProposalMail { subject: string; body: string }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const NAME_MAX = 60, BUSINESS_MAX = 120;

/** The client's link base, or null: https only, never workers.dev (`guestLinkBase`), and never the cold-email host. */
export function clientBase(env: Pick<Env, "CLIENT_LINK_BASE" | "OUTREACH_LINK_BASE">): string | null {
  const base = guestLinkBase(env.CLIENT_LINK_BASE);
  if (!base) return null;
  const cold = guestLinkBase(env.OUTREACH_LINK_BASE);
  return cold && new URL(cold).hostname.toLowerCase() === new URL(base).hostname.toLowerCase() ? null : base;
}

/** The client's link to a proposal, or null when the base is not an https address. */
export function clientLink(base: string | undefined, token: string): string | null {
  const b = guestLinkBase(base);
  return b ? `${b}/p/${token}` : null;
}

/** "December 31, 2026": the day the page itself shows (UTC). */
const longDay = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));

/**
 * The mail that carries a proposal link: the same words for every client, with a fixed template. Nothing in it is written by a model, and the only dollar
 * figure is the deposit from the schedule (every other price is in the proposal itself). What a person typed (the contact's name, the business name) is
 * shown as typed, on one line; the sender escapes it when it makes the html.
 */
export function renderProposalMail(c: ProposalContent, link: string, s: Settings): ProposalMail {
  const h = c.header;
  const first = oneLine(h.contactName).split(" ")[0].slice(0, NAME_MAX);
  const provider = oneLine(h.providerBusiness) || oneLine(h.providerName) || "us";
  // The sender adds the saved signature after the body; only when there is none does the body carry the name itself.
  const sender = parseSignature(s.signature_json) || s.signature.trim() ? "" : oneLine(s.your_name);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Here is the proposal for ${oneLine(h.clientName).slice(0, BUSINESS_MAX)}, ready for you to read and sign:`,
    link,
    `${h.expiresOn ? `It stays open until ${longDay(h.expiresOn)}. ` : ""}To accept it, open it, read it, type your name to sign.`,
    `The deposit is ${dollars(c.schedule.depositCents)}. The payment step follows signing, so there is nothing to pay today.`,
    "Reply to this email if you have a question.",
    ["Thanks,", sender].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your proposal from ${provider}`, body };
}

/**
 * The mail that gives the signer their copy: the same words for every client. The only text a person wrote that reaches it is the business name, on one
 * line and capped. The link is the client's own page, which serves the signed PDF; without one the mail says to reply for it.
 */
export function renderSignedCopyMail(c: ProposalContent, link: string | null, s: Settings): ProposalMail {
  const h = c.header;
  const provider = oneLine(h.providerBusiness) || oneLine(h.providerName) || "us";
  const sender = parseSignature(s.signature_json) || s.signature.trim() ? "" : oneLine(s.your_name);
  const body = [
    "Hi,",
    `Thank you for signing the proposal for ${oneLine(h.clientName).slice(0, BUSINESS_MAX)}. Your signed copy, with its record of the signature, is here:`,
    link ?? "Reply to this email and I will send it to you.",
    "Keep it for your records. Reply to this email if you have a question.",
    ["Thanks,", sender].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your signed proposal from ${provider}`, body };
}

/** The short note to the owner that a proposal was signed. Nothing the signer typed is in it. */
export function renderSignedNotice(c: ProposalContent): ProposalMail {
  const h = c.header;
  const name = oneLine(h.clientName).slice(0, BUSINESS_MAX);
  const ref = oneLine(h.reference);
  return { subject: `${name} signed ${ref}`, body: `${name} signed proposal ${ref}, version ${h.version}.\n\nThe signed PDF is on the deal.` };
}
