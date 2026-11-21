import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import type { Approval } from "../db/approvals";
import { logActivity } from "../db/activity";
import { getBooking } from "../db/bookings";
import { getMeeting, markFollowupSent, type Meeting } from "../db/meetings";
import { pocFor } from "../db/people";
import { getSettings } from "../db/settings";
import { isTestClient } from "../clients/record";
import { mainMailboxProblem } from "../booking/mail";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import type { MeetingSummary } from "../meetings/summary";

/**
 * The approval behind the follow-up mail to a client after a meeting. The summary task drafts it (nothing is mailed by the task); approving it sends the
 * mail from the `main` mailbox. The payload is only the meeting: the subject and body are read from the stored summary when the approval is run, so
 * what goes out is what the summary holds, and nothing in the approval can be swapped for other text.
 */
const Payload = z.object({ meetingId: z.string().min(1).max(100) }).strict();
export type MeetingFollowupPayload = z.infer<typeof Payload>;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The sentence for a follow-up with nowhere to go. A test goes to the owner's own address, so its fix is in Settings. */
const NO_OWNER_EMAIL = "Add your contact email in Settings first: the test goes to it.";
const NO_CLIENT_EMAIL = "this client has no contact email to send the follow-up to";

export interface FollowupRecipient { to: string; name: string | null; test: boolean; ownerName: string }

/**
 * Who the follow-up goes to: the contact on the meeting's booking, or the lead's point of contact when the meeting has no booking. A test client's
 * follow-up is a message to the owner and only the owner, never an address that belongs to the client. `to` is empty when there is none.
 */
export async function followupRecipient(env: Env, meeting: Pick<Meeting, "businessId" | "bookingId">): Promise<FollowupRecipient> {
  const [settings, test] = await Promise.all([getSettings(env.DB), isTestClient(env.DB, meeting.businessId)]);
  const ownerName = settings.your_name.trim() || "You";
  if (test) return { to: settings.contact_email.trim(), name: ownerName, test: true, ownerName };
  const booking = meeting.bookingId ? await getBooking(env.DB, meeting.bookingId) : null;
  if (booking?.contactEmail.trim()) return { to: booking.contactEmail.trim(), name: oneLine(booking.contactName) || null, test: false, ownerName };
  const poc = await pocFor(env.DB, meeting.businessId);
  return { to: poc?.email?.trim() ?? "", name: poc ? oneLine(poc.name) || null : null, test: false, ownerName };
}

/** The mail as it will go: a test is marked in the subject, as an onboarding test is. */
export const followupMail = (r: Pick<FollowupRecipient, "test">, f: MeetingSummary["followUp"]) => ({ subject: r.test ? `[Test] ${f.subject.trim()}` : f.subject.trim(), body: f.body.trim() });

/** The approval's preview: who it goes to, the subject and the words, as the mail will read. */
export async function describeFollowup(env: Env, meeting: Pick<Meeting, "businessId" | "bookingId">, f: MeetingSummary["followUp"]): Promise<string> {
  const r = await followupRecipient(env, meeting);
  const m = followupMail(r, f);
  const who = !r.to ? "(no email address on file yet)"
    : r.test ? `${r.ownerName} <${r.to}> (a test: nothing goes to the client)`
    : `${r.name ? `${r.name} ` : ""}<${r.to}>`.trim();
  return [`To: ${who}`, `Subject: ${m.subject}`, "", m.body].join("\n");
}

registerHandler({
  kind: "meeting.followup",
  label: "Send meeting follow-up",
  parse: (p) => Payload.parse(p),
  /**
   * Sends the stored follow-up once. A meeting whose follow-up already went (`followupSentAt`) sends nothing, so a second approval is harmless. The mail goes with
   * the approval id as the once-only key, and the meeting is marked only after it went, so a failed send can be approved again. Anything that stops the mail
   * (no summary, the mailbox, no address) throws, which puts the approval back to pending to be fixed and run again.
   */
  async execute(env: Env, p: MeetingFollowupPayload, a: Approval) {
    const meeting = await getMeeting(env.DB, p.meetingId);
    if (!meeting) throw new Error("this meeting was not found");
    if (!meeting.summary) throw new Error("this meeting has no summary, so there is no follow-up to send");
    if (meeting.followupSentAt) {
      if (!(await isTestClient(env.DB, meeting.businessId))) await logActivity(env.DB, meeting.businessId, "note", "Meeting follow-up not sent again: it already went");
      return;
    }

    const problem = await mainMailboxProblem(env);
    if (problem) throw new Error(`The main mailbox cannot send: ${problem}`);
    const r = await followupRecipient(env, meeting);
    if (!r.to) throw new Error(r.test ? NO_OWNER_EMAIL : NO_CLIENT_EMAIL);
    const m = followupMail(r, meeting.summary.followUp);
    await sendEmail(env, { mailbox: "main", to: r.to, subject: m.subject, body: m.body, includeFooter: false, ...(r.test ? {} : { businessId: meeting.businessId }) }, { approvalId: a.id, skipLimits: true });
    await markFollowupSent(env.DB, meeting.id, getMailDeps().now().toISOString());
    if (!r.test) await logActivity(env.DB, meeting.businessId, "note", `Meeting follow-up sent: ${oneLine(m.subject)}`.slice(0, 400));
  },
});
