import type { Env } from "../env";
import type { Mailbox, MailboxKey } from "../mail/types";

export const MAILBOX_KEYS: readonly MailboxKey[] = ["outreach", "main"];

export async function getMailbox(db: D1Database, key: MailboxKey): Promise<Mailbox> {
  const row = await db.prepare(`SELECT * FROM mailboxes WHERE key = ?`).bind(key).first<Mailbox>();
  if (!row) throw new Error(`mailbox ${key} missing`);
  return row;
}

const COLUMNS = new Set<string>([
  "enabled", "smtp_host", "smtp_port", "imap_host", "imap_port", "username", "from_email", "from_name",
  "warmup_started_at", "imap_uid_validity", "imap_last_uid", "last_sync_at", "last_sync_error",
]);

export async function saveMailbox(db: D1Database, key: MailboxKey, patch: Partial<Omit<Mailbox, "key">>): Promise<Mailbox> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length) {
    // Column names are whitelisted (they are interpolated); values are bound.
    for (const [k] of entries) if (!COLUMNS.has(k)) throw new Error(`unknown mailbox column ${k}`);
    const cols = entries.map(([k]) => `${k} = ?`).join(", ");
    await db.prepare(`UPDATE mailboxes SET ${cols} WHERE key = ?`).bind(...entries.map(([, v]) => v), key).run();
  }
  return getMailbox(db, key);
}

/** The mailbox password from its Worker secret; null when not set. Never stored in D1. */
export function mailboxPassword(env: Env, key: MailboxKey): string | null {
  const v = key === "outreach" ? env.MAILBOX_OUTREACH_PASSWORD : env.MAILBOX_MAIN_PASSWORD;
  return v ? v : null;
}

/** Stamps warmup_started_at once. false when it was already started (the stamp is never overwritten). */
export async function startWarmup(db: D1Database, key: MailboxKey, at: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE mailboxes SET warmup_started_at = ? WHERE key = ? AND warmup_started_at IS NULL`).bind(at, key).run();
  return (r.meta.changes ?? 0) > 0;
}
