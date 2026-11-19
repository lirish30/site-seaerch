import type { Env } from "../env";
import { checkConflict } from "../conflict";
import { logActivity } from "../db/activity";
import { upcomingBookings, type Booking } from "../db/bookings";
import { getSettings } from "../db/settings";
import { mainMailboxProblem, renderReminder, sendBookingMail } from "./mail";

/** Minutes before the start that each reminder is for (spec 9.4): 24 hours, 60 minutes, 10 minutes. */
export const REMINDER_OFFSETS = [1440, 60, 10] as const;
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number];
/** How long after its time a reminder may still go out. Past that it is skipped, never sent late ("in 10 minutes" after the start). */
export const REMINDER_WINDOW_MIN: Record<ReminderOffset, number> = { 1440: 15, 60: 15, 10: 5 };

const MIN = 60_000;

/**
 * Which reminders are due at `now`: for a confirmed booking, the ones where `start - offset <= now < start - offset + window` that are not in `sent`.
 * A booking made inside a window gets that reminder at once, and one made after a window has passed never gets it.
 */
export function dueReminders(bookings: Booking[], sent: { bookingId: string; offsetMin: number }[], now: Date): { bookingId: string; offsetMin: ReminderOffset }[] {
  const done = new Set(sent.map((s) => `${s.bookingId}:${s.offsetMin}`));
  const out: { bookingId: string; offsetMin: ReminderOffset }[] = [];
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    const start = Date.parse(b.startAt);
    for (const offsetMin of REMINDER_OFFSETS) {
      const from = start - offsetMin * MIN;
      if (now.getTime() >= from && now.getTime() < from + REMINDER_WINDOW_MIN[offsetMin] * MIN && !done.has(`${b.id}:${offsetMin}`)) out.push({ bookingId: b.id, offsetMin });
    }
  }
  return out;
}

/**
 * The 5-minute sweep. Each due reminder is claimed first (`INSERT OR IGNORE` on (booking, offset)); only the tick whose insert landed sends it, so two
 * overlapping ticks cannot both. A send that fails gives the claim back, so the next tick tries again while the window lasts (unless the failure says the
 * message may already have gone, which keeps the claim: a doubled reminder is worse than a missed one). A lead that may no longer be contacted keeps its claim
 * too and is logged once, so it is not looked at again. A mailbox that is not set up sends nothing and claims nothing, so setting it up in time still sends.
 * `skipped` counts reminders not sent this tick for any of those reasons.
 */
export async function sendDueReminders(env: Env, now: Date): Promise<{ sent: number; skipped: number }> {
  const db = env.DB, result = { sent: 0, skipped: 0 };
  const from = now.toISOString(), to = new Date(now.getTime() + 1440 * MIN + 1).toISOString();
  const bookings = await upcomingBookings(db, now, new Date(to));
  if (!bookings.length) return result;
  const claimed = (await db.prepare(`SELECT booking_id, offset_min FROM booking_reminders WHERE booking_id IN (SELECT id FROM bookings WHERE start_at >= ? AND start_at < ?)`)
    .bind(from, to).all<{ booking_id: string; offset_min: number }>()).results.map((r) => ({ bookingId: r.booking_id, offsetMin: r.offset_min }));
  const due = dueReminders(bookings, claimed, now);
  if (!due.length) return result;

  const problem = await mainMailboxProblem(env);
  if (problem) {
    console.error(`booking reminders: ${due.length} due but not sent: ${problem}`);
    return { sent: 0, skipped: due.length };
  }
  const settings = await getSettings(db), byId = new Map(bookings.map((b) => [b.id, b]));
  for (const d of due) {
    const b = byId.get(d.bookingId)!;
    const claim = await db.prepare(`INSERT OR IGNORE INTO booking_reminders (booking_id, offset_min, sent_at) VALUES (?,?,?)`).bind(b.id, d.offsetMin, now.toISOString()).run();
    if ((claim.meta.changes ?? 0) !== 1) continue; // another tick has it
    try {
      const gate = await checkConflict(db, { email: b.contactEmail, businessId: b.businessId });
      if (gate.blocked) {
        await logActivity(db, b.businessId, "note", `reminder not sent: ${gate.reason}`);
        result.skipped++;
        continue;
      }
      await sendBookingMail(env, b, renderReminder(b, d.offsetMin, settings));
      result.sent++;
    } catch (e) {
      const text = e instanceof Error ? e.message : "unknown error";
      console.error("booking reminders: a reminder could not be sent", d.offsetMin, text);
      if (!text.startsWith("the message was sent but")) {
        await db.prepare(`DELETE FROM booking_reminders WHERE booking_id = ? AND offset_min = ?`).bind(b.id, d.offsetMin).run()
          .catch((err) => console.error("booking reminders: could not give the claim back", err instanceof Error ? err.message : "unknown error"));
      }
      result.skipped++;
    }
  }
  return result;
}
