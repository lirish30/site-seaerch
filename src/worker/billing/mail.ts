import { dollars } from "../../client/packagesView";
import { getBusiness } from "../db/businesses";
import { lastBookingFor } from "../db/bookings";
import { isSingleAddress } from "../db/changeOrders";
import { getDocument, type Document } from "../db/documents";
import type { InvoiceRow } from "../db/invoices";
import { getOnboarding } from "../db/onboardings";
import { pocFor } from "../db/people";
import { getPackage } from "../db/packages";
import { getProject } from "../db/projects";
import type { Subscription } from "../db/subscriptions";
import { parseSignature } from "../email/signature";
import type { Env } from "../env";
import type { Settings } from "../types";

export interface InvoiceMail { subject: string; body: string }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-10" -> "December 10, 2026" (the date is a calendar date: no time zone moves it). */
export const longDate = (d: string): string => {
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

export interface ReminderMail { subject: string; body: string }

/**
 * The reminder for an unpaid invoice: the same words for every client, a fixed template, nothing written by a model. `step` is 1-based and `total` is how many steps the ladder has. A step
 * before the due date is a heads-up, one on it a plain reminder, a later one says it is overdue, and the last step (when overdue) also says the project's work pauses on `pauseOn` unless the invoice is
 * paid, or, when `c.today` is on or after `pauseOn`, that work cannot continue until it is paid. `c.offset` is the step's own offset from the due date in days; without it the default ladder's order is used (first a heads-up, second the due date, then overdue). An invoice that
 * failed to take payment links the hosted invoice page, where the client updates the payment method. What a person typed (the contact's name, the description, the sender's name) is shown as typed,
 * on one line and capped; the sender escapes it.
 */
export function renderReminder(
  step: number, total: number, inv: InvoiceRow, link: string, c: { contactName: string; yourName: string; pauseOn: string; offset?: number; today?: string },
): ReminderMail {
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const what = oneLine(inv.description).slice(0, 200);
  const amount = dollars(inv.amountCents);
  const date = inv.failedOn ?? inv.dueOn;
  const day = date ? longDate(date) : "";
  const tone: "ahead" | "today" | "late" = c.offset !== undefined ? (c.offset < 0 ? "ahead" : c.offset === 0 ? "today" : "late") : step <= 1 ? "ahead" : step === 2 ? "today" : "late";
  const failed = inv.status === "failed";
  // Only an overdue last step says anything about the pause. Once `pauseOn` is today or past, a date in the future tense would be wrong (and the hold may already be placed), so it says what is true either way.
  const last = step >= total && tone === "late";
  const pauseLine = c.today !== undefined && c.pauseOn <= c.today
    ? "Work on your project cannot continue until this invoice is paid. If something is in the way, reply to this email and we will sort it out."
    : `If it is not paid by ${longDate(c.pauseOn)}, work on the project pauses on that date until it is. If something is in the way, reply to this email and we will sort it out.`;

  const lead = failed
    ? `The payment for your invoice for ${what}, ${amount}, did not go through${day ? ` on ${day}` : ""}.${tone === "late" ? " It is now overdue." : ""}`
    : tone === "ahead" ? `A heads-up that your invoice for ${what} is coming up: ${amount} is due${day ? ` on ${day}` : ""}.`
    : tone === "today" ? `A quick reminder that your invoice for ${what}, ${amount}, is due today${day ? ` (${day})` : ""}.`
    : `Your invoice for ${what}, ${amount}, ${day ? `was due on ${day} and ` : ""}is now overdue.`;
  const action = failed
    ? "You can update your payment method, and pay the invoice, on its page here:"
    : "You can read it and pay it online, by card or bank transfer, here:";
  const body = [
    first ? `Hi ${first},` : "Hi,",
    lead,
    action,
    link,
    last ? pauseLine : "",
    tone === "ahead" ? "If you have already paid, thank you, and please ignore this note." : "If you have already paid, thank you, and please ignore this note. Reply to this email if you have a question.",
    ["Thanks,", oneLine(c.yourName)].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
  const subject = failed ? `Your payment for ${what} did not go through`
    : tone === "ahead" ? `Reminder: ${what} is due${day ? ` on ${day}` : " soon"}`
    : tone === "today" ? `Reminder: ${what} is due today`
    : `Overdue: ${what}${day ? `, due ${day}` : ""}`;
  return { subject: subject.slice(0, 200), body };
}

export interface SubscriptionLinkMail { subject: string; body: string }

/**
 * The mail that carries a subscription's link (the client's own page, where they start the monthly payment through Stripe's Checkout): the same words for every client, a fixed template,
 * nothing written by a model. It says the plan, the monthly price, the date of the first payment and the term when there is one. What a person typed (the client's and the contact's names,
 * the plan's name) is shown as typed, on one line and capped; the sender escapes it.
 */
export function renderSubscriptionLink(
  sub: Pick<Subscription, "monthlyCents" | "firstChargeOn" | "termMonths">, link: string,
  c: { clientName: string; contactName: string; yourName: string; planName: string },
): SubscriptionLinkMail {
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(c.clientName).slice(0, 120);
  const plan = oneLine(c.planName).slice(0, 120);
  const amount = [
    `Amount: ${dollars(sub.monthlyCents)} a month.`,
    sub.firstChargeOn ? `The first payment is on ${longDate(sub.firstChargeOn)}.` : "",
    sub.termMonths ? `The term is ${sub.termMonths} months.` : "",
  ].filter(Boolean).join(" ");
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Here is the link to set up the monthly payment for ${client}: ${plan}.`,
    amount,
    "You can set it up online, by card or bank transfer, here:",
    link,
    "Reply to this email if you have a question.",
    ["Thanks,", oneLine(c.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your monthly ${plan} plan for ${client}`.slice(0, 200), body };
}

export interface TermNoticeMail { subject: string; body: string }

/**
 * The mail that tells a client their fixed term is ending: the same words for every client, a fixed template, nothing written by a model. It says the date the term ends, that the site then
 * moves to Care at the Care monthly price, and that a reply asks for a refresh instead. What a person typed (the client's and the contact's names, the plan's name) is shown as typed, on one
 * line and capped; the sender escapes it.
 */
export function renderTermNotice(
  sub: Pick<Subscription, "termEndsOn">,
  c: { clientName: string; contactName: string; yourName: string; planName: string; careMonthlyCents: number; careContinues?: boolean },
): TermNoticeMail {
  const first = oneLine(c.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(c.clientName).slice(0, 120);
  const plan = oneLine(c.planName).slice(0, 120);
  const ends = sub.termEndsOn ? longDate(sub.termEndsOn) : "soon";
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `The ${plan} term for ${client} ends on ${ends}.`,
    // A document that already has its own Care plan: nothing moves, the Website Subscription simply ends and Care goes on at its own price.
    c.careContinues ? `Care continues as it is now, at ${dollars(c.careMonthlyCents)} a month.` : `After that it moves to Care, at ${dollars(c.careMonthlyCents)} a month.`,
    "If you would like a refresh of the site instead, reply to this email and we will talk it through.",
    ["Thanks,", oneLine(c.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your ${plan} term for ${client} ends on ${ends}`.slice(0, 200), body };
}

/**
 * The Care subscription the SAME document already has (a build proposal normally sells the Website Subscription and Care together). `live` is its monthly price while it is still going
 * (anything but cancelled or ended); `closed` is true when the document has a Care row that is cancelled or ended. Either way the unique (document, package) index means the Website
 * Subscription cannot be renamed to Care at the end of its term.
 */
export async function existingCare(db: D1Database, sub: Pick<Subscription, "id" | "documentId">): Promise<{ live: { monthlyCents: number } | null; closed: boolean }> {
  const rows = (await db.prepare(`SELECT status, monthly_cents FROM subscriptions WHERE document_id = ? AND package_key = 'care' AND id <> ?`).bind(sub.documentId, sub.id).all<{ status: string; monthly_cents: number }>()).results;
  const live = rows.find((r) => r.status !== "cancelled" && r.status !== "ended");
  return { live: live ? { monthlyCents: live.monthly_cents } : null, closed: !live && rows.length > 0 };
}

/** The name of the plan as the client signed it (the frozen schedule line), else the catalog's name for that version, else a plain word. */
export async function subscriptionPlanName(env: Env, sub: Pick<Subscription, "documentId" | "packageKey" | "packageVersion">): Promise<string> {
  const doc = await getDocument(env.DB, sub.documentId);
  const line = doc?.content.schedule.recurring.find((r) => r.key === sub.packageKey);
  return oneLine(line?.name ?? (await getPackage(env.DB, sub.packageKey, sub.packageVersion))?.name ?? "Subscription");
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
export async function invoiceRecipient(env: Env, inv: Pick<InvoiceRow, "documentId" | "projectId" | "businessId">): Promise<Recipient> {
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
