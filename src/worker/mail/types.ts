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

export type ImapFetch = (
  mb: Mailbox, password: string, sinceUid: number | null,
) => Promise<{ uidValidity: number; uidNext: number; messages: { uid: number; raw: Uint8Array }[] }>;
