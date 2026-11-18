import type { Env } from "../env";
import { MAILBOX_KEYS, getMailbox, mailboxPassword, saveMailbox } from "../db/mailboxes";
import { activityStmt } from "../db/activity";
import { getEnrollment } from "../db/enrollments";
import { getBusiness } from "../db/businesses";
import { enqueueClaudeTaskStmt } from "../db/claudeTasks";
import { REPLY_TASK_KIND } from "../sequence/replies";
import { stopOutreach } from "../sequence/stop";
import { getMailDeps } from "./deps";
import { classifyInbound, parseInbound, type InboundMessage } from "./inbound";
import { errorText } from "./redact";
import type { Mailbox, MailboxKey } from "./types";

export interface SyncSummary {
  fetched: number; matched: number; replies: number; stopped: number; bounced: number;
  /** Set only when the run failed (the redacted IMAP or storage error). Nothing was advanced past the failure. */
  error?: string;
}

/** Fetch windows per run: a backlog drains faster than one window per 15 minutes without one run holding the Worker for long. */
const MAX_WINDOWS = 4;
/** Consecutive failing runs on one cursor before the sync gives up on the window's bad message and moves on. */
const MAX_ATTEMPTS = 5;
// Stored fields are clamped: a sender controls them, and D1 rows are limited to 2 MB.
const SUBJECT_MAX = 998;
const ADDRESS_MAX = 320;
const ID_MAX = 998;
/** References lists grow with the thread (and can be hostile); the newest entries are the ones that name our message. */
const MAX_REFERENCES = 10;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** An address fit for the do-not-contact list, or undefined. A mail system's odd Final-Recipient must never make the stop throw (it would block the mailbox on that message). */
const usable = (a: string | null | undefined): string | undefined => {
  const t = a?.trim().replace(/^<|>$/g, "").toLowerCase();
  return t && t.length <= ADDRESS_MAX && EMAIL.test(t) ? t : undefined;
};

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s);

interface Match { businessId: string; enrollmentId: string | null }

/**
 * The lead an inbound message belongs to. First by the Message-ID it answers (In-Reply-To / References against our outbound rows),
 * then, on the outreach mailbox only, by address: the DSN's failed recipient for a bounce (its sender is the mail system), otherwise the sender,
 * against the address any enrollment, in any state, wrote to (newest first). The `main` mailbox is Logan's own inbox, so there only an answer to
 * one of our messages counts: mail from an old lead's address that answers nothing of ours is not about any lead. A sender match on a client
 * (`won`) is never made. Null means the message is not about any lead of ours.
 */
async function matchLead(db: D1Database, key: MailboxKey, m: InboundMessage): Promise<Match | null> {
  const ids = new Set<string>();
  // A header is hostile input: an id longer than a real Message-ID can be is dropped, and only the newest few references are bound.
  for (const raw of [m.inReplyTo ?? "", ...m.references.slice(-MAX_REFERENCES)]) {
    const bare = raw.trim().replace(/^<|>$/g, "");
    if (bare && bare.length <= ID_MAX) { ids.add(bare); ids.add(`<${bare}>`); }
  }
  if (ids.size) {
    const list = [...ids].slice(0, 2 * (MAX_REFERENCES + 1));
    const row = await db.prepare(
      `SELECT business_id, enrollment_id FROM messages WHERE direction = 'out' AND business_id IS NOT NULL AND message_id IN (${list.map(() => "?").join(",")}) ORDER BY created_at DESC, id LIMIT 1`,
    ).bind(...list).first<{ business_id: string; enrollment_id: string | null }>();
    if (row) return { businessId: row.business_id, enrollmentId: row.enrollment_id };
  }
  if (key === "main") return null;
  const address = (m.dsn ? m.dsn.recipient : m.from)?.trim().toLowerCase();
  if (!address) return null;
  const e = await db.prepare(
    `SELECT e.id, e.business_id, b.lead_status FROM enrollments e LEFT JOIN businesses b ON b.id = e.business_id WHERE LOWER(e.to_email) = ? ORDER BY e.started_at DESC, e.id LIMIT 1`,
  ).bind(address).first<{ id: string; business_id: string; lead_status: string | null }>();
  return e && e.lead_status !== "won" ? { businessId: e.business_id, enrollmentId: e.id } : null;
}

/**
 * The address to list as do-not-contact for a stop or a hard bounce. `claimed` is what the mail says (a DSN's Final-Recipient, a sender's From),
 * and a forged message can claim anyone. It is used only when it is an address we wrote to for this lead (the enrollment's `to_email`, or an outbound
 * message's recipient); otherwise it is the enrollment's `to_email`, the address we actually wrote to. Undefined when there is neither.
 */
async function listableAddress(db: D1Database, businessId: string, enrollmentTo: string | null | undefined, claimed: string | null | undefined): Promise<string | undefined> {
  const known = usable(enrollmentTo);
  const c = usable(claimed);
  if (c && c === known) return c;
  if (c) {
    const sent = await db.prepare(`SELECT 1 AS x FROM messages WHERE direction = 'out' AND business_id = ? AND LOWER(counterpart) = ? LIMIT 1`).bind(businessId, c).first();
    if (sent) return c;
  }
  return known;
}

interface StoredRow { id: string; business_id: string | null; enrollment_id: string | null; processed_at: string | null }
const findStored = (db: D1Database, key: MailboxKey, uid: number) =>
  db.prepare(`SELECT id, business_id, enrollment_id, processed_at FROM messages WHERE mailbox_key = ? AND imap_uid = ?`).bind(key, uid).first<StoredRow>();

/**
 * Stores one message (when it matches a lead) and applies what it means. The row goes in first with `processed_at` NULL; the effects follow,
 * and the stamp is written in the same batch as the activity row, so a crash anywhere in between is finished by the next run (the stored row
 * is found by its UID) and nothing is logged or moved twice. The stop itself is idempotent.
 */
async function processMessage(env: Env, key: MailboxKey, m: { uid: number; raw: Uint8Array }, now: string, tally: SyncSummary): Promise<void> {
  const db = env.DB;
  let row = await findStored(db, key, m.uid);
  if (row?.processed_at) return;

  const parsed = await parseInbound(m.raw);
  const kind = classifyInbound(parsed);
  const match: Match | null = row?.business_id ? { businessId: row.business_id, enrollmentId: row.enrollment_id } : await matchLead(db, key, parsed);
  if (!match) return; // not about any lead: ignored, and not stored

  if (!row) {
    await db.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, enrollment_id, message_id, in_reply_to, counterpart, subject, text, status, kind, imap_uid, created_at)
      VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?) ON CONFLICT (mailbox_key, imap_uid) WHERE imap_uid IS NOT NULL DO NOTHING`)
      .bind(crypto.randomUUID(), key, match.businessId, match.enrollmentId, parsed.messageId?.slice(0, ID_MAX) ?? null, parsed.inReplyTo?.slice(0, ID_MAX) ?? null,
        parsed.from.slice(0, ADDRESS_MAX), parsed.subject.slice(0, SUBJECT_MAX), parsed.text, kind, m.uid, now).run();
    row = await findStored(db, key, m.uid);
    if (!row) throw new Error(`could not store message ${m.uid}`);
    if (row.processed_at) return; // another run finished it between our two reads
  }
  tally.matched++;

  const businessId = match.businessId;
  const stamp = db.prepare(`UPDATE messages SET processed_at = ? WHERE id = ?`).bind(now, row.id);
  const subject = clip(parsed.subject);
  const sender = clip(parsed.from || "unknown sender", 100);
  // A client (`won`) answering one of our messages is kept in the log, but nothing is stopped, suppressed, listed, delayed or queued for Claude.
  if ((await getBusiness(db, businessId))?.lead_status === "won") {
    await db.batch([activityStmt(db, businessId, "note", `Message from a client (${sender}): ${subject}; no outreach changes were made`), stamp]);
    return;
  }
  switch (kind) {
    case "reply": {
      await stopOutreach(db, { businessId, reason: "replied" });
      // Claude classifies the reply (and drafts the answer) through the task queue. The task goes in the same batch as the stamp, so a message
      // is either fully applied (stamped, one task) or not at all, and a failure to enqueue fails the message like any other effect.
      const classify = enqueueClaudeTaskStmt(db, REPLY_TASK_KIND, { messageId: row.id, businessId, enrollmentId: match.enrollmentId }, { dedupeKey: row.id });
      await db.batch([activityStmt(db, businessId, "email_reply", `Reply from ${sender}: ${subject}`), classify.stmt, stamp]);
      tally.replies++;
      return;
    }
    case "stop": {
      const enrollment = match.enrollmentId ? await getEnrollment(db, match.enrollmentId) : null;
      const address = await listableAddress(db, businessId, enrollment?.to_email, parsed.from);
      await stopOutreach(db, { businessId, reason: "opt_out", ...(address ? { email: address } : {}) });
      await db.batch([activityStmt(db, businessId, "email_reply", `${sender} asked to stop: ${subject}`), stamp]);
      tally.stopped++;
      return;
    }
    case "bounce_hard": {
      const enrollment = match.enrollmentId ? await getEnrollment(db, match.enrollmentId) : null;
      const address = await listableAddress(db, businessId, enrollment?.to_email, parsed.dsn?.recipient);
      await stopOutreach(db, { businessId, reason: "bounced", ...(address ? { email: address } : {}) });
      await db.batch([activityStmt(db, businessId, "email_bounce", `Bounced${address ? `: ${clip(address, 100)}` : ""} (${parsed.dsn?.status ?? "failed"})`), stamp]);
      tally.bounced++;
      return;
    }
    case "bounce_soft":
      await db.batch([activityStmt(db, businessId, "email_bounce", `Temporary delivery problem (${parsed.dsn?.status ?? "4.x.x"}); nothing changed`), stamp]);
      return;
    case "auto_reply": {
      // The push is one SQL expression on the current value, so an overlapping run (or a send) that moved the step meanwhile is never overwritten.
      const enrollment = match.enrollmentId ? await getEnrollment(db, match.enrollmentId) : null;
      const delays = enrollment?.status === "active" && enrollment.next_due_at !== null;
      await db.batch([
        ...(delays ? [db.prepare(`UPDATE enrollments SET next_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_due_at, '+7 days') WHERE id = ? AND status = 'active' AND next_due_at IS NOT NULL`).bind(enrollment!.id)] : []),
        activityStmt(db, businessId, "note", `Automatic reply from ${sender}${delays ? "; the next step is delayed 7 days" : ""}`),
        stamp,
      ]);
      return;
    }
  }
}

/**
 * Pulls new mail for one mailbox and acts on it. Throws only when the mailbox cannot be synced at all (no password secret, not configured).
 * Anything that goes wrong while syncing (IMAP, storage) is written to `last_sync_error` and returned as `error`: the cursor stays where it was,
 * so the next run retries the same window. Each message is applied in isolation, so one bad message cannot keep the others in its window
 * (a later stop, say) from being applied; after MAX_ATTEMPTS failing runs on the same cursor the window is skipped past.
 *
 * SECURITY: inbound mail is NOT authenticated. There is no SPF, DKIM or Authentication-Results check, and a message is matched to a lead by the
 * Message-ID it answers or, on the outreach mailbox, simply by its From address. A forged reply, stop or bounce notice can therefore end a lead's
 * sequence. That fails safe (it only ever stops outreach) and is reversible from the do-not-contact list and the lead page. What it can put on the
 * do-not-contact list is limited to an address we wrote to for that lead (see `listableAddress`), never an arbitrary From or Final-Recipient.
 * The `main` mailbox matches only by the Message-ID of our own outbound mail, and a client (`won`) is never matched by address or stopped.
 */
export async function syncMailbox(env: Env, key: MailboxKey): Promise<SyncSummary> {
  const db = env.DB;
  const mb: Mailbox = await getMailbox(db, key);
  const password = mailboxPassword(env, key);
  if (!password) throw new Error("password secret is not set");
  if (!mb.imap_host || !mb.username) throw new Error("mailbox is not configured");

  const deps = getMailDeps();
  const now = deps.now().toISOString();
  const tally: SyncSummary = { fetched: 0, matched: 0, replies: 0, stopped: 0, bounced: 0 };
  const notes: string[] = [];
  let gaveUp: string | null = null;
  try {
    // First run: remember where the mailbox ends now. Old mail is history, never imported.
    if (mb.imap_last_uid === null) {
      const r = await deps.imap(mb, password, null);
      await saveMailbox(db, key, { imap_last_uid: r.uidNext - 1, imap_uid_validity: r.uidValidity, last_sync_at: now, last_sync_error: null, imap_fail_count: 0, imap_fail_cursor: null });
      return tally;
    }
    let cursor = mb.imap_last_uid;
    let validity = mb.imap_uid_validity;
    let failCount = mb.imap_fail_count ?? 0;
    let failCursor = mb.imap_fail_cursor ?? null;
    for (let window = 0; window < MAX_WINDOWS; window++) {
      const r = await deps.imap(mb, password, cursor);
      if (validity !== null && r.uidValidity !== validity) {
        // The UIDs we hold mean nothing any more: start over from the end of the mailbox, importing nothing. Stored UIDs are released in the
        // same batch (the unique index ignores NULLs) so a new-epoch mail that reuses one is not mistaken for a message already done.
        const note = "mailbox UID validity changed; baseline reset";
        await db.batch([
          db.prepare(`UPDATE messages SET imap_uid = NULL WHERE mailbox_key = ? AND direction = 'in'`).bind(key),
          db.prepare(`UPDATE mailboxes SET imap_last_uid = ?, imap_uid_validity = ?, last_sync_at = ?, last_sync_error = ?, imap_fail_count = 0, imap_fail_cursor = NULL WHERE key = ?`)
            .bind(r.uidNext - 1, r.uidValidity, now, note, key),
        ]);
        console.warn(`mail sync ${key}: ${note}`);
        return tally;
      }
      tally.fetched += r.messages.length;
      const failures: { uid: number; error: string }[] = [];
      for (const m of [...r.messages].sort((a, b) => a.uid - b.uid)) {
        try { await processMessage(env, key, m, now, tally); }
        catch (e) { failures.push({ uid: m.uid, error: errorText(e, password) }); }
      }
      if (r.skipped.length) {
        const note = `skipped ${r.skipped.length} oversized message(s): uids ${r.skipped.map((x) => x.uid).join(", ")}`;
        notes.push(note);
        console.warn(`mail sync ${key}: ${note}`);
      }
      if (failures.length) {
        const first = failures[0];
        const count = failCursor === cursor ? failCount + 1 : 1;
        if (count < MAX_ATTEMPTS) {
          // Hold the cursor: the whole window is read again next run. Messages already applied are skipped there (processed_at), and the failing one retried.
          const error = `failed on uid ${first.uid}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ""}: ${first.error}`;
          await saveMailbox(db, key, { imap_fail_count: count, imap_fail_cursor: cursor, last_sync_error: error });
          return { ...tally, error };
        }
        // Everything else in the window was applied (and the effects are idempotent), so the only loss is the message that keeps failing.
        gaveUp = `gave up on uid ${first.uid} after ${MAX_ATTEMPTS} attempts: ${first.error}`;
        console.warn(`mail sync ${key}: ${gaveUp}`);
        notes.push(gaveUp);
      }
      // Only after the whole window was applied: the highest UID examined, so an oversized mail never blocks the ones behind it.
      const next = Math.max(cursor, r.highestUid);
      await saveMailbox(db, key, { imap_last_uid: next, imap_uid_validity: r.uidValidity, imap_fail_count: 0, imap_fail_cursor: null });
      failCount = 0; failCursor = null;
      const progressed = next > cursor;
      cursor = next; validity = r.uidValidity;
      if (!progressed || cursor >= r.uidNext - 1) break;
    }
    await saveMailbox(db, key, { last_sync_at: now, last_sync_error: notes.length ? notes.join("; ") : null });
    return gaveUp ? { ...tally, error: gaveUp } : tally;
  } catch (e) {
    const error = errorText(e, password);
    await saveMailbox(db, key, { last_sync_error: error }).catch(() => { /* the error is still returned and logged by the caller */ });
    return { ...tally, error };
  }
}

/**
 * The 15-minute cron: syncs every enabled mailbox that has its password secret. Never throws, and one mailbox failing does not stop the
 * other. It logs only when there was mail or an error, so an idle mailbox leaves no noise in the logs.
 */
export async function syncAllMailboxes(env: Env): Promise<void> {
  for (const key of MAILBOX_KEYS) {
    try {
      const mb = await getMailbox(env.DB, key);
      const password = mailboxPassword(env, key);
      if (!mb.enabled || !password) continue;
      let result: SyncSummary;
      try {
        result = await syncMailbox(env, key);
      } catch (e) {
        const error = errorText(e, password);
        await saveMailbox(env.DB, key, { last_sync_error: error });
        result = { fetched: 0, matched: 0, replies: 0, stopped: 0, bounced: 0, error };
      }
      if (result.error) console.error(`mail sync ${key} failed: ${result.error}`);
      else if (result.fetched > 0) console.log(`mail sync ${key}`, JSON.stringify(result));
    } catch (e) {
      console.error(`mail sync ${key} failed`, e);
    }
  }
}
