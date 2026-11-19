import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import { createApproval, toApproval, type Approval } from "../db/approvals";
import { logActivityOnce } from "../db/activity";
import { getDocument } from "../db/documents";
import { getOnboarding, markWelcomeSent, type Onboarding } from "../db/onboardings";
import { getSettings } from "../db/settings";
import { mainMailboxProblem } from "../booking/mail";
import { clientBase } from "../documents/mail";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { onboardingLink } from "../onboarding/link";
import { renderWelcome } from "../onboarding/mail";
import { dueDatesFor } from "../onboarding/schedule";

const Payload = z.object({ onboardingId: z.string().min(1) });
export type OnboardingWelcomePayload = z.infer<typeof Payload>;

export const CLIENT_BASE_PROBLEM = "Set CLIENT_LINK_BASE (an https address for client links, not the cold-email host) before sending.";
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Everything the welcome needs, read fresh each time: the document's contact, the owner's settings, the link, and the mail itself. */
async function build(env: Env, o: Onboarding) {
  const doc = await getDocument(env.DB, o.documentId);
  if (!doc) throw new Error("this onboarding's proposal was not found");
  const settings = await getSettings(env.DB);
  const link = onboardingLink(clientBase(env) ?? undefined, o.token);
  if (!link) throw new Error(CLIENT_BASE_PROBLEM);
  const h = doc.content.header;
  const mail = renderWelcome(o, { clientName: h.clientName, contactName: h.contactName }, link, settings);
  // A test onboarding is a message to the owner and only the owner: the contact on the document is never written to.
  const to = o.test ? settings.contact_email.trim() : h.contactEmail.trim();
  return { doc, settings, link, h, to, subject: o.test ? `[Test] ${mail.subject}` : mail.subject, body: mail.body };
}

const waiting = (db: D1Database, onboardingId: string) => db.prepare(
  `SELECT * FROM approvals WHERE kind = 'onboarding.welcome' AND status = 'pending' AND json_extract(payload, '$.onboardingId') = ? ORDER BY created_at, id`,
).bind(onboardingId).all<Parameters<typeof toApproval>[0]>().then((r) => r.results.map(toApproval));

/** The approval's title and preview, from the onboarding as it is now: who it goes to, the subject, the words and the video link (if one is set). */
async function describe(env: Env, o: Onboarding): Promise<{ title: string; preview: string }> {
  const w = await build(env, o);
  const who = o.test
    ? `${w.settings.your_name.trim() || "You"} <${w.to}> (a test: nothing goes to ${w.h.contactEmail.trim() || "the client"})`
    : `${oneLine(w.h.contactName) || w.h.clientName} <${w.to}>`;
  const preview = [
    `To: ${who}`, `Subject: ${w.subject}`, "", w.body, "",
    `Welcome video: ${o.welcomeVideoUrl ?? "none yet (add the link on the onboarding page before you approve, or the mail goes without one)"}`,
  ].join("\n");
  return { title: `Send the onboarding welcome to ${w.h.clientName}`, preview };
}

/**
 * Puts the welcome mail up for approval: who it goes to, the subject, the words and the video link (if one is set). One waiting approval per onboarding:
 * a second call returns the first. Nothing is mailed until Logan approves.
 */
export async function createWelcomeApproval(env: Env, o: Onboarding): Promise<Approval> {
  const db = env.DB;
  const first = (await waiting(db, o.id))[0];
  if (first) return first;

  const d = await describe(env, o);
  const a = await createApproval(db, {
    kind: "onboarding.welcome", title: d.title, preview: d.preview, payload: { onboardingId: o.id } satisfies OnboardingWelcomePayload,
    record_type: "deal", record_id: o.dealId, drafted_by: "logan",
  });
  // Two callers at once: the earliest approval stands, the other is dropped.
  const winner = (await waiting(db, o.id))[0];
  if (winner && winner.id !== a.id) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    return winner;
  }
  return a;
}

/**
 * Rewrites the preview of the welcome that is waiting (the video link or the client's link changed since it was made), the same way it was first built.
 * The mail itself is always built when it is sent; this keeps what Logan reads before approving true. Never throws: a preview that cannot be rebuilt stays as it was.
 */
export async function refreshWelcomePreview(env: Env, o: Onboarding): Promise<void> {
  try {
    const pending = (await waiting(env.DB, o.id))[0];
    if (!pending) return;
    const { preview } = await describe(env, o);
    await env.DB.prepare(`UPDATE approvals SET preview = ? WHERE id = ? AND status = 'pending'`).bind(preview, pending.id).run();
  } catch (e) {
    console.error("onboarding: could not refresh the welcome preview", e instanceof Error ? e.message : "unknown error");
  }
}

/** True when this onboarding has a welcome approval in any state (waiting, approved or rejected). */
export async function hasWelcomeApproval(db: D1Database, onboardingId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM approvals WHERE kind = 'onboarding.welcome' AND json_extract(payload, '$.onboardingId') = ? LIMIT 1`).bind(onboardingId).first());
}

registerHandler({
  kind: "onboarding.welcome",
  label: "Send onboarding welcome",
  parse: (p) => Payload.parse(p),
  /**
   * In order, each step safe to repeat: mail the welcome with the approval id as the once-only key (a retry after a sent mail sends nothing, and the
   * approval can be run again to finish), record that it went out with the due dates, log it once. The mailbox is checked only while the welcome is unsent,
   * so a retry is never refused for a setting that changed after the mail went out.
   */
  async execute(env: Env, p: OnboardingWelcomePayload, a: Approval) {
    const o = await getOnboarding(env.DB, p.onboardingId);
    if (!o) throw new Error("this onboarding was not found");
    if (!o.welcomeSentAt) {
      if (o.closedAt) throw new Error("this onboarding is closed");
      if (o.revokedAt) throw new Error("this onboarding's link was revoked, so a welcome with that link cannot go out");
      const problem = await mainMailboxProblem(env);
      if (problem) throw new Error(`The main mailbox cannot send: ${problem}`);
    }
    const w = await build(env, o);
    if (!w.to) throw new Error(o.test ? "Add your contact email in Settings first: the test goes to it." : "this proposal has no contact email");

    // A test goes to the owner with no lead on it, as `sendTest` does; the checks a real cold send makes are not this mail's (the client has just paid).
    await sendEmail(env, { mailbox: "main", to: w.to, subject: w.subject, body: w.body, includeFooter: false, ...(o.test ? {} : { businessId: o.businessId }) }, { approvalId: a.id, skipLimits: true });

    const sentAt = getMailDeps().now();
    await markWelcomeSent(env.DB, o.id, { sentAt: sentAt.toISOString(), ...dueDatesFor(sentAt) });
    await logActivityOnce(env.DB, o.businessId, "onboarding_welcome", `${o.test ? "Test welcome" : "Welcome"} mailed to ${w.to}`);
  },
});
