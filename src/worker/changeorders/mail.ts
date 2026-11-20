import { dollars } from "../../client/packagesView";
import type { ChangeOrder } from "../db/changeOrders";
import { parseSignature } from "../email/signature";
import type { Settings } from "../types";

/** What the mail is: a one-line subject and a plain-text body. The sender builds the html from the body (escaping it) and adds the signature block. */
export interface ChangeOrderMail { subject: string; body: string }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** "1 hour", "2.5 hours". */
export const hoursText = (h: number): string => `${h} ${h === 1 ? "hour" : "hours"}`;

/**
 * The mail that carries a change-order link: the same words for every client, with a fixed template. Nothing in it is written by a model. The hours, the rate and the price
 * are the order's own figures. What a person typed (the contact's name, the client's name, the title) is shown as typed, on one line and capped; the sender escapes it.
 */
export function renderChangeOrderMail(co: ChangeOrder, link: string, s: Settings): ChangeOrderMail {
  const c = co.content;
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const title = oneLine(c.title).slice(0, 80);
  const client = oneLine(c.clientName).slice(0, 120);
  // The sender adds the saved signature after the body; only when there is none does the body carry the name itself.
  const sender = parseSignature(s.signature_json) || s.signature.trim() ? "" : oneLine(s.your_name);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Some extra work came up on the project for ${client}: ${title}. It is written up as a change order, ready for you to read and sign:`,
    link,
    `It comes to ${hoursText(c.hours)} at ${dollars(c.rateCents)} an hour, ${dollars(c.priceCents)} in total.`,
    "Nothing starts until you sign and the invoice is paid.",
    "Reply to this email if you have a question.",
    ["Thanks,", sender].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Change order for ${client}: ${title}`, body };
}
