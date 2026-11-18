export type MailboxKey = "outreach" | "main";

/** A mailbox row. The password is never here: it is a Worker secret (see mailboxPassword). */
export interface Mailbox {
  key: MailboxKey;
  enabled: 0 | 1;
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  username: string;
  from_email: string;
  from_name: string;
  warmup_started_at: string | null;
  imap_uid_validity: number | null;
  imap_last_uid: number | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  /** Consecutive sync runs that failed to apply a message while the cursor sat at `imap_fail_cursor`. */
  imap_fail_count: number;
  imap_fail_cursor: number | null;
}

export interface OutboundMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
}

export type SmtpSend = (mb: Mailbox, password: string, msg: OutboundMessage) => Promise<void>;

export interface ImapFetchResult {
  uidValidity: number;
  uidNext: number;
  messages: { uid: number; raw: Uint8Array }[];
  /**
   * The highest UID this call examined, INCLUDING messages skipped for size. The sync advances its
   * cursor to this value so one oversized or unreadable mail can never block the ones behind it.
   * With `sinceUid === null` it is the baseline (`uidNext - 1`); when nothing is new it is `sinceUid`.
   */
  highestUid: number;
  /** Messages at or below `highestUid` that were not downloaded because they exceed the size limit. */
  skipped: { uid: number; size: number }[];
}

export type ImapFetch = (mb: Mailbox, password: string, sinceUid: number | null) => Promise<ImapFetchResult>;

/** Logs in and selects INBOX, fetching no messages. Used by the connection test. */
export type ImapProbe = (mb: Mailbox, password: string) => Promise<{ uidValidity: number }>;
