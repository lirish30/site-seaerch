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
import { errorText } from "./redact";
import { checkConflict } from "../conflict";
import { getEnrollment } from "../db/enrollments";
import { advanceAfterSend } from "../sequence/advance";
import { liveReportTarget } from "../db/reports";
import { publishedVideoForAudit } from "../db/videoAudits";
import { isLive } from "../sequence/types";
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
export function composeOutbound(s: Settings, p: Pick<SendInput, "mailbox" | "subject" | "body" | "includeFooter" | "heroImage">, forceFooter = true): ComposedEmail {
  const include = p.mailbox === "outreach" && forceFooter ? true : p.includeFooter;
  return composeEmail(s, { subject: p.subject, body: p.body, include_footer: include, ...(p.heroImage ? { hero: p.heroImage } : {}) });
}

/** The main brand domain. Cold email never links it (or any subdomain, such as clients.): cold links use OUTREACH_LINK_BASE. */
export const BRAND_HOST = "sitelineweb.com";
/** Path prefixes of the app's public pages (report and proposal pages). On cold email they must be served from the outreach host. */
export const PUBLIC_PAGE_PREFIXES = ["/r/", "/p/", "/o/"];

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]]+$/;
/** A URL's host, lower-cased and without a trailing dot (`sitelineweb.com.` is the same host as `sitelineweb.com`). Null when it does not parse. */
const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return null; } };
/** The host of the cold-link base, or null when it does not parse or is not `https:` (a cold link is never plain http). */
const linkBaseHost = (base: string): string | null => { try { return new URL(base).protocol === "https:" ? hostOf(base) : null; } catch { return null; } };

/**
 * Why this message may not be sent because of the links in it, or null when it is clean.
 * Every mailbox: no workers.dev. Outreach only: no link to the main brand domain, and no public-page link on a host other than
 * the one in OUTREACH_LINK_BASE (checked only when it is set; a set but invalid or non-https value blocks cold sends). Third-party hosts (a signature website, a logo CDN) pass.
 * A video email's `hero` is held to more: on the outreach mailbox both its links must be on the host OUTREACH_LINK_BASE names right now, and with no
 * base to compare to the send is blocked, so a base changed after approval cannot send a link to the old host.
 */
export function linkProblem(c: Pick<ComposedEmail, "text" | "html">, mailbox: MailboxKey, linkBase: string | undefined, hero?: { src: string; href: string }): string | null {
  const all = `${c.text}\n${c.html}`;
  if (/workers\.dev/i.test(all)) return "message mentions workers.dev; links must use your own domain";
  if (mailbox !== "outreach") return null;
  const baseHost = linkBase?.trim() ? linkBaseHost(linkBase.trim()) : null;
  // A configured but unparseable (or non-https) base must not silently switch the public-page rule off.
  if (linkBase?.trim() && !baseHost) return `OUTREACH_LINK_BASE (${linkBase.trim()}) is not a valid URL, so cold email is blocked until it is fixed (expected something like https://go.example.com)`;
  if (hero) {
    if (!baseHost) return "this video email needs OUTREACH_LINK_BASE (https only) to be set, so its video link can be checked, and it is not";
    for (const url of [hero.href, hero.src]) {
      const host = hostOf(url);
      if (host !== baseHost) return `video link ${url} is on ${host ?? "an unreadable host"}, but OUTREACH_LINK_BASE is now ${linkBase!.trim().replace(/\/+$/, "")}; re-propose the email so the video link uses it`;
    }
  }
  for (const url of new Set([...all.matchAll(URL_RE)].map((m) => m[0].replace(TRAILING, "")))) {
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    if (host === BRAND_HOST || host.endsWith(`.${BRAND_HOST}`)) {
      return `link ${url} is on the main brand domain (${BRAND_HOST}); cold email must link the outreach domain${baseHost ? ` (${linkBase})` : ""}`;
    }
    if (baseHost && host !== baseHost && PUBLIC_PAGE_PREFIXES.some((p) => u.pathname.startsWith(p))) {
      return `link ${url} is a public page on ${host}; cold email must link the outreach domain, so change it to ${linkBase!.trim().replace(/\/+$/, "")}${u.pathname}`;
    }
  }
  return null;
}

/** Said when a video email's link no longer leads to a live video for this lead. */
export const HERO_NOT_LIVE = "the video link is no longer live: make a new one";

/** The report token in a hero's two links (`/r/<token>` and `/api/public/report/<token>/media/...`), or null when either does not have one. Both must name the same one. */
function heroToken(hero: { src: string; href: string }): string | null {
  try {
    const href = /^\/r\/([A-Za-z0-9_-]{43})$/.exec(new URL(hero.href).pathname)?.[1];
    const src = /^\/api\/public\/report\/([A-Za-z0-9_-]{43})\//.exec(new URL(hero.src).pathname)?.[1];
    return href && href === src ? href : null;
  } catch { return null; }
}

/**
 * Why a video email's hero may not go out, or null when it may: its report link must be live (not revoked, not expired) and belong to THIS lead, and the
 * audit it is for must have a published video. The approval was made some time ago: the link may have been revoked, or the video unpublished, since.
 * A hero put in by anyone else (it is not the app's to trust) is held to the same rule.
 */
export async function heroProblem(db: D1Database, p: Pick<SendInput, "businessId" | "heroImage">, now: Date): Promise<string | null> {
  if (!p.heroImage) return null;
  const token = p.businessId ? heroToken(p.heroImage) : null;
  const target = token ? await liveReportTarget(db, token, now) : null;
  if (!target || target.businessId !== p.businessId) return HERO_NOT_LIVE;
  return (await publishedVideoForAudit(db, target.auditId)) ? null : HERO_NOT_LIVE;
}

/**
 * True when this send is an answer to something the lead actually wrote to us: `inReplyTo` is the Message-ID of an INBOUND message of kind `reply`
 * (not an auto-reply, a bounce or a stop) stored for the SAME business, and the recipient is that message's sender. Such a send is not cold mail, so the warm-up lock and the daily cap do not apply.
 * A caller-supplied `inReplyTo` alone never qualifies.
 */
async function isReplyToInbound(db: D1Database, p: SendInput): Promise<boolean> {
  const id = p.inReplyTo?.trim().replace(/^<|>$/g, "");
  if (!p.businessId || !id) return false;
  const row = await db.prepare(
    `SELECT 1 AS x FROM messages WHERE direction = 'in' AND kind = 'reply' AND business_id = ? AND message_id IN (?, ?) AND LOWER(TRIM(counterpart)) = ? LIMIT 1`,
  ).bind(p.businessId, id, `<${id}>`, p.to.trim().toLowerCase()).first();
  return row !== null;
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
 * What runs once a message is recorded as sent: a sequence step moves its enrollment on (`advanceAfterSend`). Other messages have nothing to do.
 * IDEMPOTENT by contract: it runs again on every retry of an approval whose row is already `sent` (after a failure here the approval returns
 * to pending, and the retry skips the send and only repeats this). `advanceAfterSend` guards itself with `last_sent_step`.
 */
async function advanceSequence(env: Env, p: SendInput): Promise<void> {
  if (!p.enrollmentId || p.stepIndex === undefined) return;
  // The time the message went out, so a retry hours later still schedules from the real send; the clock only if the row is not found.
  const row = await env.DB.prepare(`SELECT sent_at FROM messages WHERE enrollment_id = ? AND step_index = ? AND direction = 'out' AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`)
    .bind(p.enrollmentId, p.stepIndex).first<{ sent_at: string | null }>();
  await advanceAfterSend(env.DB, p.enrollmentId, p.stepIndex, row?.sent_at ? new Date(row.sent_at) : getMailDeps().now());
}
let afterSendImpl: (env: Env, p: SendInput) => Promise<void> = advanceSequence;
export const afterSend = (env: Env, p: SendInput): Promise<void> => afterSendImpl(env, p);
/** Tests only: replace the hook; null restores the real one. */
export function setAfterSendForTests(fn: ((env: Env, p: SendInput) => Promise<void>) | null): void {
  afterSendImpl = fn ?? advanceSequence;
}

/**
 * The one path every outgoing message takes. Real sends (`skipLimits` false) run checks 3 to 6 in order: cold-mail footer, link guard,
 * warm-up and daily cap (not for an answer to a message the lead sent us, see `isReplyToInbound`), then the once-only send. `skipLimits` is for test messages to the mailbox's own address.
 *
 * Once-only: the `messages` row (status 'sending', UNIQUE on approval_id) is written BEFORE SMTP is called. If a row already
 * exists: 'sent' is a no-op, 'failed' is retried, and 'sending' is refused because the earlier attempt may have reached the server
 * (a crash after SMTP accepted the message leaves exactly that row). Resolving such a row is left to a human.
 */
export async function sendEmail(env: Env, p: SendInput, opts: { approvalId: string | null; skipLimits?: boolean }): Promise<void> {
  const db = env.DB, deps = getMailDeps(), now = deps.now(), real = !opts.skipLimits;
  if (real && !opts.approvalId) throw new Error("sendEmail: a real send needs an approvalId (programmer error)");
  if (opts.approvalId) {
    // Already sent: skip every check (a retry must not fail on a cap, a setting or a signature that changed since) and only
    // repeat the idempotent after-send step, which an earlier attempt may not have completed.
    const done = await getByApproval(db, opts.approvalId);
    if (done?.status === "sent") return afterSend(env, p);
  }
  const { mb, password } = await loadSendable(env, p.mailbox, real);
  if (real) { // the conflict gate: a listed recipient, a suppressed lead or an existing client is never written to
    const c = await checkConflict(db, { email: p.to, businessId: p.businessId });
    if (c.blocked) throw new Error(`blocked: ${c.reason} (${c.source})`);
    if (p.enrollmentId) { // stop beats approval: a reply, bounce or "stop" after the approval was made ends the sequence, and its leftover approvals send nothing
      const e = await getEnrollment(db, p.enrollmentId);
      if (!e || !isLive(e.status)) throw new Error(`sequence stopped: ${e ? e.status : "enrollment not found"}`);
    }
  }
  const settings = await getSettings(db);

  if (real && p.mailbox === "outreach") {
    if (!settings.physical_address.trim()) throw new Error("add your mailing address in Settings before sending cold email");
    if (!settings.opt_out_line.trim()) throw new Error("add an opt-out line in Settings before sending cold email");
  }
  const composed = composeOutbound(settings, p, real);
  if (real) {
    const problem = linkProblem(composed, p.mailbox, env.OUTREACH_LINK_BASE, p.heroImage) ?? (await heroProblem(db, p, now));
    if (problem) throw new Error(problem);
    if (p.mailbox === "outreach" && !(await isReplyToInbound(db, p))) await assertWithinLimit(db, mb, now);
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
    if (existing.status === "sent") return afterSend(env, p); // sent by a concurrent attempt since the lookup above
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
    throw new Error(errorText(e, password)); // the text ends up in approvals.error: never let the secret reach D1
  }
  try {
    await markSent(db, rowId, now.toISOString());
  } catch (e) {
    throw new Error(`the message was sent but could not be recorded, so it may already have been sent: ${errorText(e, password)}`);
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
