import type { Mailbox, MailboxKey } from "./types";

export const WARMUP_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whole days since warm-up started, or null when it has not started (or the stamp is unreadable). */
export function warmupAgeDays(mb: Pick<Mailbox, "warmup_started_at">, now: Date): number | null {
  if (!mb.warmup_started_at) return null;
  const start = Date.parse(mb.warmup_started_at);
  return Number.isNaN(start) ? null : Math.floor((now.getTime() - start) / DAY_MS);
}

/** Cold sends allowed per rolling 24h: nothing for the first 30 days, then 5 / 10 / 20 by mailbox age. */
export function dailyLimit(mb: Pick<Mailbox, "warmup_started_at">, now: Date): number {
  const days = warmupAgeDays(mb, now);
  if (days === null || days < WARMUP_DAYS) return 0;
  if (days < 45) return 5;
  if (days < 60) return 10;
  return 20;
}

/** The day (YYYY-MM-DD) cold sends unlock, or null when warm-up has not started. */
export function warmupUnlockDate(mb: Pick<Mailbox, "warmup_started_at">): string | null {
  const start = mb.warmup_started_at ? Date.parse(mb.warmup_started_at) : NaN;
  return Number.isNaN(start) ? null : new Date(start + WARMUP_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** Prospect messages sent in the 24h ending at `now`. Test messages have no business, so they never count. */
export async function sentInLast24h(db: D1Database, key: MailboxKey, now: Date): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM messages
    WHERE mailbox_key = ? AND direction = 'out' AND status = 'sent' AND business_id IS NOT NULL AND sent_at > ? AND sent_at <= ?`)
    .bind(key, new Date(now.getTime() - DAY_MS).toISOString(), now.toISOString()).first<{ n: number }>();
  return row?.n ?? 0;
}
