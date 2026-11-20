import { dollars } from "../../client/packagesView";
import { getBusiness } from "../db/businesses";
import { lastBookingFor } from "../db/bookings";
import { isSingleAddress } from "../db/changeOrders";
import { getDocument, type Document } from "../db/documents";
import type { InvoiceRow } from "../db/invoices";
import { getOnboarding } from "../db/onboardings";
import { pocFor } from "../db/people";
import { getProject } from "../db/projects";
import { parseSignature } from "../email/signature";
import type { Env } from "../env";
import type { Settings } from "../types";

export interface InvoiceMail { subject: string; body: string }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-10" -> "December 10, 2026" (the date is a calendar date: no time zone moves it). */
const longDate = (d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : d;
};

/** The sender's name for the end of the mail, or "" when a saved signature will follow the body (the sender adds it) so the name is not said twice. */
export function signOff(s: Pick<Settings, "signature_json" | "signature" | "your_name">): string {
  return parseSignature(s.signature_json) || s.signature.trim() ? "" : oneLine(s.your_name);
}

/**
 * The mail that carries an invoice's hosted link: the same words for every client, a fixed template, nothing written by a model. It says the amount, what the invoice is for and when
 * it is due, then the link (Stripe's page, where the client pays). What a person typed (the contact's and the client's names, the description) is shown as typed, on one line and capped;
 * the sender escapes it. Nothing about the project's tasks is in it.
 */
export function renderInvoiceMail(inv: InvoiceRow, link: string, c: { clientName: string; contactName: string; yourName: string }): InvoiceMail {
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(c.clientName).slice(0, 120);
  const what = oneLine(inv.description).slice(0, 200);
  const due = inv.dueOn ? `It is due on ${longDate(inv.dueOn)}.` : "It is due on receipt.";
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Here is the invoice for ${client}: ${what}.`,
    `Amount: ${dollars(inv.amountCents)}. ${due}`,
    "You can read it and pay it online, by card or bank transfer, here:",
    link,
    "Reply to this email if you have a question.",
    ["Thanks,", oneLine(c.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Invoice for ${client}: ${what}`.slice(0, 200), body };
}

/** Who an invoice goes to. `to` is a single, plain address. */
export interface Recipient { to: string; clientName: string; contactName: string }

const clean = (e: string | null | undefined): string => (e ?? "").replace(/[\r\n\t]/g, "").trim();
const usable = (e: string): boolean => e.includes("@") && isSingleAddress(e);
const fromDocument = (d: Document | null): Recipient | null => {
  const h = d?.content.header;
  const to = clean(h?.contactEmail);
  return h && usable(to) ? { to, clientName: oneLine(h.clientName), contactName: oneLine(h.contactName) } : null;
};

export const NO_RECIPIENT = "This invoice has nobody to go to: add a contact email to the lead (or its proposal) first.";

/**
 * Where an invoice goes: the contact on the invoice's signed document, else on the document the project's onboarding was made from, else the contact from the discovery call booking,
 * else the lead's point of contact. Throws a plain sentence when there is none. Nothing is sent here.
 */
export async function invoiceRecipient(env: Env, inv: InvoiceRow): Promise<Recipient> {
  const db = env.DB;
  const hit = fromDocument(inv.documentId ? await getDocument(db, inv.documentId) : null);
  if (hit) return hit;
  const project = inv.projectId ? await getProject(db, inv.projectId) : null;
  const onboarding = project?.onboardingId ? await getOnboarding(db, project.onboardingId) : null;
  const viaOnboarding = fromDocument(onboarding ? await getDocument(db, onboarding.documentId) : null);
  if (viaOnboarding) return viaOnboarding;

  const business = await getBusiness(db, inv.businessId);
  const clientName = oneLine(business?.name ?? "");
  const booking = await lastBookingFor(db, inv.businessId, "discovery");
  const bookedTo = clean(booking?.contactEmail);
  if (booking && usable(bookedTo)) return { to: bookedTo, clientName, contactName: oneLine(booking.contactName) };
  const poc = await pocFor(db, inv.businessId);
  const pocTo = clean(poc?.email);
  if (poc && usable(pocTo)) return { to: pocTo, clientName, contactName: oneLine(poc.name) };
  throw new Error(NO_RECIPIENT);
}
