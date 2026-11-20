import { parseConfig } from "../booking/config";
import { dayKey } from "../booking/slots";
import type { Settings } from "../types";
import type { Cadence } from "./model";

/** The zone dates and weeks are counted in when the settings hold one Intl does not know (the booking config's own default). */
export const FALLBACK_ZONE = "America/Los_Angeles";

/** The owner's IANA zone from the booking config, checked with Intl: one it does not know gives Los Angeles, not an error. */
export function zoneOf(settings: Pick<Settings, "booking_config">): string {
  const tz = parseConfig(settings.booking_config).timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return FALLBACK_ZONE; }
}

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar date as a UTC-midnight epoch (the date itself, with no zone in it) and back to `YYYY-MM-DD`. */
const dateMs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar date `d` falls on in `tz`. */
function localDate(d: Date, tz: string): { y: number; m: number; d: number } {
  const [y, m, day] = dayKey(d.getTime(), tz).split("-").map(Number);
  return { y, m, d: day };
}

/** The Monday of the ISO week a date is in, and that week's number and year (a week belongs to the year that holds its Thursday). */
function isoWeekOf(dayMs: number): { monday: number; year: number; week: number } {
  const monday = dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * DAY;
  const thursday = monday + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  return { monday, year, week: Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1 };
}

/** The Monday of week `w` of ISO year `y`: week 1 is the one that holds 4 January. */
const mondayOfWeek = (y: number, w: number) => isoWeekOf(dateMs(y, 1, 4)).monday + (w - 1) * 7 * DAY;

/**
 * The period an instant falls in, counted on the calendar in `tz`: an ISO week ("2026-W48", Monday to Sunday), a month ("2026-11"), a quarter ("2026-Q4") or a year ("2026").
 * This is the key that makes a recurring task once per period.
 */
export function periodKey(c: Cadence, d: Date, tz: string): string {
  const l = localDate(d, tz);
  switch (c) {
    case "weekly": { const w = isoWeekOf(dateMs(l.y, l.m, l.d)); return `${w.year}-W${pad(w.week)}`; }
    case "monthly": return `${l.y}-${pad(l.m)}`;
    case "quarterly": return `${l.y}-Q${Math.ceil(l.m / 3)}`;
    case "annual": return String(l.y);
  }
}

/** What a period is called in a task title: "Week of Nov 23" (its Monday), "November 2026", "Q4 2026", "2026". A key it cannot read comes back unchanged. */
export function periodLabel(c: Cadence, key: string): string {
  switch (c) {
    case "weekly": {
      const m = /^(\d{4})-W(\d{2})$/.exec(key);
      if (!m || +m[2] < 1 || +m[2] > 53) return key;
      const monday = new Date(mondayOfWeek(+m[1], +m[2]));
      return `Week of ${MONTHS[monday.getUTCMonth()].slice(0, 3)} ${monday.getUTCDate()}`;
    }
    case "monthly": {
      const m = /^(\d{4})-(\d{2})$/.exec(key);
      return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${m[1]}` : key;
    }
    case "quarterly": {
      const m = /^(\d{4})-Q([1-4])$/.exec(key);
      return m ? `Q${m[2]} ${m[1]}` : key;
    }
    case "annual": return key;
  }
}

/**
 * The date, as `YYYY-MM-DD`, a recurring task of the period `d` is in is due. Weekly: `cadenceDay` is the ISO weekday (3 gives that week's Wednesday). Monthly: the day of the month.
 * Quarterly and annual: the day of the month, in the first month of the quarter or year. No day gives the last day of the period (Sunday, month end, quarter end, 31 December).
 * A day past the end of a short month is the month's last day.
 */
export function dueOnFor(c: Cadence, cadenceDay: number | null, d: Date, tz: string): string {
  const l = localDate(d, tz);
  switch (c) {
    case "weekly": return dateText(isoWeekOf(dateMs(l.y, l.m, l.d)).monday + ((cadenceDay ?? 7) - 1) * DAY);
    case "monthly": return dateText(dateMs(l.y, l.m, Math.min(cadenceDay ?? 31, lastDayOf(l.y, l.m))));
    case "quarterly": {
      const first = Math.floor((l.m - 1) / 3) * 3 + 1;
      return cadenceDay === null ? dateText(dateMs(l.y, first + 2, lastDayOf(l.y, first + 2))) : dateText(dateMs(l.y, first, Math.min(cadenceDay, lastDayOf(l.y, first))));
    }
    case "annual": return cadenceDay === null ? `${l.y}-12-31` : dateText(dateMs(l.y, 1, Math.min(cadenceDay, 31)));
  }
}
