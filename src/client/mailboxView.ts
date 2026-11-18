import type { MailboxKey } from "./types";

/** Days of warm-up before any cold send. Mirrors WARMUP_DAYS in src/worker/mail/limits.ts (a test keeps the two in step). */
export const WARMUP_DAYS = 30;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Dec 18": the date in UTC, so the words do not depend on the machine's time zone. */
const monDay = (ms: number) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

/** Whole days since the clock started, or null when it has not (or the stamp is unreadable). */
function ageDays(mb: { warmup_started_at: string | null }, now: Date): { start: number; days: number } | null {
  const start = mb.warmup_started_at ? Date.parse(mb.warmup_started_at) : NaN;
  return Number.isNaN(start) ? null : { start, days: Math.floor((now.getTime() - start) / DAY_MS) };
}

/** Cold sends allowed per rolling 24h: nothing for the first 30 days, then 5 / 10 / 20. The same arithmetic as the worker's `dailyLimit`. */
export function dailyLimitFor(mb: { warmup_started_at: string | null }, now: Date): number {
  const age = ageDays(mb, now);
  if (!age || age.days < WARMUP_DAYS) return 0;
  if (age.days < 45) return 5;
  if (age.days < 60) return 10;
  return 20;
}

/** The warm-up status under a mailbox: not started, which day of 30 and when cold sends unlock, or the daily limit. */
export function warmupLine(mb: { warmup_started_at: string | null }, now: Date): string {
  const age = ageDays(mb, now);
  if (!age) return "Warm-up not started";
  if (age.days < WARMUP_DAYS) return `Warm-up day ${Math.max(0, age.days) + 1} of ${WARMUP_DAYS}. Cold sends unlock on ${monDay(age.start + WARMUP_DAYS * DAY_MS)}`;
  return `Warm-up complete. Up to ${dailyLimitFor(mb, now)} a day`;
}

/** The sync's own non-failure notes, which it stores in `last_sync_error` (see syncMailbox): a UID-validity reset and an oversized-mail warning. */
const isSyncNote = (text: string) => text.startsWith("mailbox UID validity changed") || text.startsWith("skipped ");

/** When the reply check last ran: the failure, never, or how many whole minutes ago (with the sync's note, if it left one). */
export function syncLine(mb: { last_sync_at: string | null; last_sync_error: string | null }, now: Date): string {
  const err = mb.last_sync_error;
  if (err && !isSyncNote(err)) return `Last check failed: ${err}`;
  const at = mb.last_sync_at ? Date.parse(mb.last_sync_at) : NaN;
  if (Number.isNaN(at)) return err ? `Not checked yet. Note: ${err}` : "Not checked yet";
  const min = Math.floor((now.getTime() - at) / 60_000);
  const checked = min < 1 ? "Checked just now" : `Checked ${min} min ago`;
  return err ? `${checked}. Note: ${err}` : checked;
}

export const mailboxTitle = (key: MailboxKey) => (key === "outreach" ? "Outreach mailbox" : "Main mailbox");
/** The Worker secret that holds this mailbox's password. The page never asks for it. */
export const secretName = (key: MailboxKey) => `MAILBOX_${key.toUpperCase()}_PASSWORD`;
export const secretCommand = (key: MailboxKey) => `wrangler secret put ${secretName(key)}`;

interface Probe { ok: boolean; error?: string }
/** POST /api/mailboxes/:key/test: one line each for SMTP, IMAP and the sending domain's SPF record. */
export function testResultLines(r: { smtp: Probe; imap: Probe; spf: boolean | null }): string[] {
  const probe = (name: string, p: Probe) => (p.ok ? `${name}: ok` : `${name}: error (${p.error ?? "failed"})`);
  return [probe("SMTP", r.smtp), probe("IMAP", r.imap), `SPF: ${r.spf === null ? "unknown" : r.spf ? "yes" : "no"}`];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** POST /api/mailboxes/:key/sync: what the check found. */
export function syncSummaryLine(s: { fetched: number; matched: number; replies: number; stopped: number; bounced: number; error?: string }): string {
  if (s.error) return `Check failed: ${s.error}`;
  return `Checked: ${plural(s.fetched, "new message")}, ${s.matched} matched, ${plural(s.replies, "reply", "replies")}, ${s.stopped} stopped, ${s.bounced} bounced.`;
}
