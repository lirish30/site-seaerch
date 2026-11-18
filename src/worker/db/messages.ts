import type { MailboxKey } from "../mail/types";

export type MessageStatus = "sending" | "sent" | "failed" | "received";

export interface MessageRow {
  id: string; direction: "out" | "in"; mailbox_key: MailboxKey; business_id: string | null;
  enrollment_id: string | null; step_index: number | null; approval_id: string | null;
  message_id: string | null; in_reply_to: string | null; counterpart: string; subject: string; text: string;
  status: MessageStatus; kind: string | null; imap_uid: number | null; created_at: string; sent_at: string | null;
  /** Inbound only: set once the effects of the message (stop, bounce, activity) were applied. */
  processed_at: string | null;
}

export interface OutboundRow {
  mailbox: MailboxKey; businessId: string | null; enrollmentId: string | null; stepIndex: number | null;
  approvalId: string | null; messageId: string; inReplyTo: string | null; to: string; subject: string; text: string; now: string;
}

/**
 * Writes the outbound row in status 'sending' BEFORE the SMTP call. With an approval id the UNIQUE index makes this the
 * once-only guard: false means a row for this approval already exists (read it with `getByApproval`).
 */
export async function insertOutbound(db: D1Database, id: string, r: OutboundRow): Promise<boolean> {
  const res = await db.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, enrollment_id, step_index, approval_id, message_id, in_reply_to, counterpart, subject, text, status, created_at)
    VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?) ON CONFLICT (approval_id) DO NOTHING`)
    .bind(id, r.mailbox, r.businessId, r.enrollmentId, r.stepIndex, r.approvalId, r.messageId, r.inReplyTo, r.to, r.subject, r.text, r.now).run();
  return (res.meta.changes ?? 0) > 0;
}

export const getByApproval = (db: D1Database, approvalId: string) =>
  db.prepare(`SELECT * FROM messages WHERE approval_id = ?`).bind(approvalId).first<MessageRow>();

/** failed -> sending, atomically, with the (possibly edited) content. false when the row is not 'failed' any more. */
export async function reclaimFailed(db: D1Database, id: string, r: { to: string; subject: string; text: string }): Promise<boolean> {
  const res = await db.prepare(`UPDATE messages SET status = 'sending', counterpart = ?, subject = ?, text = ? WHERE id = ? AND status = 'failed'`)
    .bind(r.to, r.subject, r.text, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function markSent(db: D1Database, id: string, at: string): Promise<void> {
  await db.prepare(`UPDATE messages SET status = 'sent', sent_at = ? WHERE id = ?`).bind(at, id).run();
}

export async function markFailed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`).bind(id).run();
}

/** A message as the lead page shows it: no transport ids, no IMAP position, and the text cut to `TEXT_CHARS`. */
export type LeadMessage = Pick<MessageRow, "id" | "direction" | "mailbox_key" | "enrollment_id" | "step_index" | "counterpart" | "subject" | "text" | "status" | "kind" | "created_at" | "sent_at">;
const TEXT_CHARS = 500;

/** One lead's messages, newest first (by when they went out or arrived), at most `limit`. */
export async function listForBusiness(db: D1Database, businessId: string, limit = 50): Promise<LeadMessage[]> {
  const rows = (await db.prepare(
    `SELECT id, direction, mailbox_key, enrollment_id, step_index, counterpart, subject, text, status, kind, created_at, sent_at
       FROM messages WHERE business_id = ? ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT ?`,
  ).bind(businessId, limit).all<LeadMessage>()).results;
  return rows.map((m) => ({ ...m, text: m.text.slice(0, TEXT_CHARS) }));
}
