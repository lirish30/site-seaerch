import type { Env } from "../env";
import type { Settings } from "../types";
import { checkConflict } from "../conflict";
import { logActivity } from "../db/activity";
import type { Booking } from "../db/bookings";
import { httpsBase } from "../db/reports";
import { getSettings } from "../db/settings";
import { loadSendable, sendEmail } from "../mail/send";
import { DURATION_MIN, parseConfig } from "./config";

/** What a booking mail is: a subject on one line and a plain-text body. The sender builds the html from the body (escaping it) and adds the signature. */
export interface BookingMail { subject: string; body: string }

/** The same words for every guest. Nothing here is written by a model, and the only text a person typed that reaches a mail is their name. */
const LEFT = { 1440: "24 hours", 60: "1 hour", 10: "10 minutes" } as const;

/** What the booking is called to the guest: the discovery call is a "call", the recommendation meeting a "meeting". */
const noun = (b: Pick<Booking, "kind">) => (b.kind === "recommendation" ? "meeting" : "call");

/** Intl puts a no-break or narrow space before AM/PM; a mail wants a plain one. */
const tidy = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");
const part = (iso: string, tz: string, o: Intl.DateTimeFormatOptions) => tidy(new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(iso)));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** "Tuesday, November 24 at 10:00 AM Pacific Standard Time". Both mails say the time in Logan's zone and name it: the guest's zone is not known here. */
const longWhen = (iso: string, tz: string) =>
  `${part(iso, tz, { weekday: "long", month: "long", day: "numeric" })} at ${part(iso, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "long" })}`;
/** "Tue, Nov 24 at 10:00 AM PST": for a subject line. */
const shortWhen = (iso: string, tz: string) =>
  `${part(iso, tz, { weekday: "short", month: "short", day: "numeric" })} at ${part(iso, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;

/** The link base for a guest's links: https only, no trailing slash, never workers.dev (the cold-link rule). Empty when there is none to use. */
export function guestLinkBase(raw: string | undefined): string {
  const base = httpsBase(raw);
  if (!base) return "";
  try { return /(^|\.)workers\.dev$/i.test(new URL(base).hostname) ? "" : base; } catch { return ""; }
}

/**
 * The mail that goes out the moment a call is booked: the time, the Meet link and a cancel link on the outreach host. The cancel link is only
 * given when there is a link base to build it on; without one the mail says to reply instead of inventing an address.
 * `body` is plain text. The name is shown as typed (on one line); it is escaped when the sender turns the body into html.
 */
export function renderConfirmation(b: Booking, s: Settings, linkBase: string, token: string): BookingMail {
  const tz = parseConfig(s.booking_config).timezone, base = guestLinkBase(linkBase);
  const body = [
    `Hi ${oneLine(b.contactName)},`,
    `Your ${noun(b)} is booked for ${longWhen(b.startAt, tz)}. It runs ${DURATION_MIN[b.kind]} minutes.`,
    b.meetUrl ? `Join with Google Meet: ${b.meetUrl}` : "The video link was not ready when this went out. Reply to this email and I will send it.",
    base ? `Need to cancel? This link frees up the time: ${base}/r/${token}/book?cancel=${b.cancelToken}` : "Need to cancel? Just reply to this email.",
    "Talk soon.",
  ].join("\n\n");
  return { subject: `Your ${noun(b)} is booked for ${shortWhen(b.startAt, tz)}`, body };
}

/** The reminder that goes out `offsetMin` minutes before the call. No cancel link: the confirmation has it. */
export function renderReminder(b: Booking, offsetMin: 1440 | 60 | 10, s: Settings): BookingMail {
  const tz = parseConfig(s.booking_config).timezone;
  const body = [
    `Hi ${oneLine(b.contactName)},`,
    `A reminder that your ${noun(b)} is in ${LEFT[offsetMin]}, on ${longWhen(b.startAt, tz)}.`,
    b.meetUrl ? `Join with Google Meet: ${b.meetUrl}` : "Reply to this email if you need the video link.",
    "See you then.",
  ].join("\n\n");
  return { subject: `Your ${noun(b)} is in ${LEFT[offsetMin]}`, body };
}

/** Why the main mailbox cannot send right now (no password secret, not set up, switched off), or null when it can. */
export async function mainMailboxProblem(env: Env): Promise<string | null> {
  try { await loadSendable(env, "main", true); return null; }
  catch (e) { return e instanceof Error ? e.message : "the main mailbox is not available"; }
}

/**
 * Sends one booking mail from the `main` mailbox to the address the person typed. It has no approval (a fixed template to someone who asked for the call),
 * and `sendEmail` refuses a real send without one, so it goes as `skipLimits`, which also skips the checks a real send makes. The ones that matter here
 * are the callers' to make first: `mainMailboxProblem` (mailbox set up and switched on) and the conflict gate. No cold-mail footer: this is not cold mail.
 */
export async function sendBookingMail(env: Env, b: Booking, m: BookingMail): Promise<void> {
  await sendEmail(env, { mailbox: "main", to: b.contactEmail, subject: m.subject, body: m.body, includeFooter: false, businessId: b.businessId }, { approvalId: null, skipLimits: true });
}

/**
 * Sends the confirmation for a booking that just went through. `token` is the lead's report link, for the cancel link; without one the mail says to reply. It never throws: a confirmation that cannot go out (mailbox not set up, switched off, the
 * address now on a do-not-contact list, a mail server error) is logged on the lead's timeline and in the Worker log, and the booking stands.
 */
export async function sendConfirmation(env: Env, b: Booking, token: string | null): Promise<void> {
  try {
    const problem = await mainMailboxProblem(env);
    if (problem) throw new Error(problem);
    const gate = await checkConflict(env.DB, { email: b.contactEmail, businessId: b.businessId });
    if (gate.blocked) throw new Error(gate.reason);
    await sendBookingMail(env, b, renderConfirmation(b, await getSettings(env.DB), token ? guestLinkBase(env.OUTREACH_LINK_BASE) : "", token ?? ""));
  } catch (e) {
    const reason = oneLine(e instanceof Error ? e.message : "unknown error").slice(0, 200);
    console.error("booking: confirmation not sent", reason);
    await logActivity(env.DB, b.businessId, "note", `confirmation not sent: ${reason}`).catch((err) => console.error("booking: could not log the unsent confirmation", err instanceof Error ? err.message : "unknown error"));
  }
}
