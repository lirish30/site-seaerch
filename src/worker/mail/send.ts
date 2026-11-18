import type { Env } from "../env";
import type { Settings } from "../types";
import type { EmailSendPayload } from "../approvals/emailSend";
import { composeEmail, type ComposedEmail } from "../email/render";
import { getMailbox, mailboxPassword } from "../db/mailboxes";
import { getSettings } from "../db/settings";
import { getBusiness, updateLead } from "../db/businesses";
import { logActivity } from "../db/activity";
import { getByApproval, insertOutbound, markFailed, markSent, reclaimFailed } from "../db/messages";
import { getMailDeps } from "./deps";
import { dailyLimit, sentInLast24h, warmupUnlockDate } from "./limits";
import type { Mailbox, MailboxKey } from "./types";

/** What `sendEmail` takes. `businessId` is optional here only: test messages to the mailbox itself have no lead. */
export type SendInput = Omit<EmailSendPayload, "businessId"> & { businessId?: string };

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** Check 1: the mailbox exists, is configured, has its password secret, and (for real sends) is switched on. */
export async function loadSendable(env: Env, key: MailboxKey, requireEnabled: boolean): Promise<{ mb: Mailbox; password: string }> {
  const mb = await getMailbox(env.DB, key);
  const password = mailboxPassword(env, key);
  if (!password) throw new Error("password secret is not set");
  if (!mb.smtp_host || !mb.from_email.includes("@")) throw new Error("mailbox is not configured");
  if (requireEnabled && !mb.enabled) throw new Error(`mailbox ${key} is not enabled`);
  return { mb, password };
}

/**
 * The text and html that will be sent. Cold mail (the outreach mailbox) always carries the footer, so `includeFooter`
 * is ignored there. `forceFooter` is false only for test messages to the mailbox itself.
 */
export function composeOutbound(s: Settings, p: Pick<SendInput, "mailbox" | "subject" | "body" | "includeFooter">, forceFooter = true): ComposedEmail {
  const include = p.mailbox === "outreach" && forceFooter ? true : p.includeFooter;
  return composeEmail(s, { subject: p.subject, body: p.body, include_footer: include });
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]]+$/;

/** Why this message may not be sent because of the links in it, or null when it is clean. */
export function linkProblem(c: Pick<ComposedEmail, "text" | "html">, mailbox: MailboxKey, linkBase: string | undefined): string | null {
  const all = `${c.text}\n${c.html}`;
  if (/workers\.dev/i.test(all)) return "message mentions workers.dev; links must use your own domain";
  if (mailbox !== "outreach") return null;
  const urls = [...all.matchAll(URL_RE)].map((m) => m[0].replace(TRAILING, ""));
  if (!urls.length) return null;
  const base = (linkBase ?? "").trim().replace(/\/+$/, "").toLowerCase();
  if (!base) return "OUTREACH_LINK_BASE is not set, so cold email cannot contain links";
  const inside = (u: string) => { const l = u.toLowerCase(); return l === base || (l.startsWith(base) && "/?#".includes(l[base.length])); };
  const bad = urls.find((u) => !inside(u));
  return bad ? `link outside OUTREACH_LINK_BASE (${linkBase}): ${bad}` : null;
}

/** Check 5: warm-up and the rolling daily cap. Cold sends only. */
async function assertWithinLimit(db: D1Database, mb: Mailbox, now: Date): Promise<void> {
  const limit = dailyLimit(mb, now);
  if (limit === 0) {
    const unlock = warmupUnlockDate(mb);
    throw new Error(unlock ? `warm-up: cold sends unlock on ${unlock}` : "warm-up: not started, so cold sends are locked until 30 days after you start it");
  }
  if ((await sentInLast24h(db, mb.key, now)) >= limit) throw new Error(`daily limit reached (${limit})`);
}

/**
 * Extension point for Task 7 (sequences): runs once after a message is recorded as sent, to advance the enrollment.
 * A no-op until then.
 */
export async function afterSend(_env: Env, _p: SendInput): Promise<void> {}

/**
 * The one path every outgoing message takes. Real sends (`skipLimits` false) run checks 3 to 6 in order: cold-mail footer, link guard,
 * warm-up and daily cap, then the once-only send. `skipLimits` is for test messages to the mailbox's own address.
 *
 * Once-only: the `messages` row (status 'sending', UNIQUE on approval_id) is written BEFORE SMTP is called. If a row already
 * exists: 'sent' is a no-op, 'failed' is retried, and 'sending' is refused because the earlier attempt may have reached the server
 * (a crash after SMTP accepted the message leaves exactly that row). Resolving such a row is left to a human.
 */
export async function sendEmail(env: Env, p: SendInput, opts: { approvalId: string | null; skipLimits?: boolean }): Promise<void> {
  const db = env.DB, deps = getMailDeps(), now = deps.now(), real = !opts.skipLimits;
  const { mb, password } = await loadSendable(env, p.mailbox, real);
  const settings = await getSettings(db);

  if (real && p.mailbox === "outreach") {
    if (!settings.physical_address.trim()) throw new Error("add your mailing address in Settings before sending cold email");
    if (!settings.opt_out_line.trim()) throw new Error("add an opt-out line in Settings before sending cold email");
  }
  const composed = composeOutbound(settings, p, real);
  if (real) {
    const problem = linkProblem(composed, p.mailbox, env.OUTREACH_LINK_BASE);
    if (problem) throw new Error(problem);
    if (p.mailbox === "outreach") await assertWithinLimit(db, mb, now);
  }

  const fresh = `<${crypto.randomUUID()}@${domainOf(mb.from_email)}>`;
  const row = {
    mailbox: p.mailbox, businessId: p.businessId ?? null, enrollmentId: p.enrollmentId ?? null, stepIndex: p.stepIndex ?? null,
    approvalId: opts.approvalId, messageId: fresh, inReplyTo: p.inReplyTo ?? null, to: p.to, subject: composed.subject, text: composed.text, now: now.toISOString(),
  };
  let rowId: string = crypto.randomUUID(), messageId = fresh;
  if (!(await insertOutbound(db, rowId, row))) {
    const existing = opts.approvalId ? await getByApproval(db, opts.approvalId) : null;
    if (!existing) throw new Error("could not record the message; nothing was sent");
    if (existing.status === "sent") return;
    const retry = existing.status === "failed" && (await reclaimFailed(db, existing.id, { to: p.to, subject: composed.subject, text: composed.text }));
    if (!retry) throw new Error("an earlier send for this approval is unresolved and may already have been sent; check the mailbox's Sent folder before retrying");
    rowId = existing.id;
    messageId = existing.message_id ?? fresh; // a retry keeps its Message-ID so a duplicate is recognisable
  }

  try {
    await deps.smtp(mb, password, {
      from: { email: mb.from_email, name: mb.from_name }, to: p.to, subject: composed.subject, text: composed.text, html: composed.html,
      messageId, ...(p.inReplyTo ? { inReplyTo: p.inReplyTo, references: [p.inReplyTo] } : {}),
    });
  } catch (e) {
    await markFailed(db, rowId).catch(() => { /* the row stays 'sending', which refuses a resend: the safe side */ });
    throw e;
  }
  try {
    await markSent(db, rowId, now.toISOString());
  } catch (e) {
    throw new Error(`the message was sent but could not be recorded, so it may already have been sent: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (p.businessId && (p.stepIndex === undefined || p.stepIndex === 0)) {
    try {
      const lead = await getBusiness(db, p.businessId);
      // Only a lead nobody has contacted yet moves to 'contacted'; replied/won/lost keep their status.
      if (lead && (lead.lead_status === "new" || lead.lead_status === "reviewed")) await updateLead(db, p.businessId, { leadStatus: "contacted" });
      await logActivity(db, p.businessId, "note", `Email sent: ${p.subject}`);
    } catch (e) {
      console.error("email sent but the lead update failed", e); // the send is done; do not put the approval back to pending
    }
  }
  await afterSend(env, p);
}
