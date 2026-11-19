/** Logan's zone: Today says "today" and "tomorrow" by his calendar, whatever zone the browser is in. */
export const CALLS_ZONE = "America/Los_Angeles";
const DAY = 86_400_000;
/** How far ahead the Today card looks. */
export const CALLS_AHEAD_DAYS = 7;

export type CallLabel = "today" | "tomorrow" | "later";

/** One row of GET /api/today/calls. */
export interface CallRow { id: string; businessId: string; businessName: string; contactName: string; startAt: string; meetUrl: string | null }

/** The calendar date ("2026-11-18") an instant falls on in `tz`. */
const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** The date after `day`, by calendar arithmetic (so a 23- or 25-hour day cannot skip or repeat one). */
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The confirmed calls that start in the next 7 days, soonest first, each labelled today, tomorrow or later by the Pacific calendar. */
export function upcomingCalls<T extends { startAt: string }>(bookings: T[], now: Date, tz = CALLS_ZONE): { label: CallLabel; booking: T }[] {
  const from = now.getTime(), to = from + CALLS_AHEAD_DAYS * DAY;
  const today = dayOf(now, tz), tomorrow = nextDay(today);
  return bookings
    .filter((b) => { const t = Date.parse(b.startAt); return t >= from && t < to; })
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .map((booking) => {
      const day = dayOf(new Date(booking.startAt), tz);
      return { label: day === today ? "today" : day === tomorrow ? "tomorrow" : "later", booking } as { label: CallLabel; booking: T };
    });
}

const clock = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)).replace(/[  ]/g, " ");

/** "Today, 3:00 PM PST", "Tomorrow, 9:00 AM PST", or "Mon, Nov 23, 10:00 AM PST": when a call is, in Pacific time with the zone named. */
export function callWhen(iso: string, label: CallLabel, tz = CALLS_ZONE): string {
  if (label === "today") return `Today, ${clock(iso, tz)}`;
  if (label === "tomorrow") return `Tomorrow, ${clock(iso, tz)}`;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  return `${date}, ${clock(iso, tz)}`;
}
