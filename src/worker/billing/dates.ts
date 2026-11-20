import { dayKey } from "../booking/slots";

/** Calendar dates are `YYYY-MM-DD` strings with no zone in them. They are counted as UTC-midnight days, which a clock change never moves. */
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const parts = (d: string): [number, number, number] => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new RangeError(`not a calendar date: ${d}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const text = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => { const [y, m, day] = parts(d); return Date.UTC(y, m - 1, day); };

/** The calendar date `now` falls on in the zone `tz`. */
export const calendarDateIn = (now: Date, tz: string): string => dayKey(now.getTime(), tz);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const calendarDaysBetween = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / DAY);

export const addDays = (d: string, n: number): string => text(ms(d) + n * DAY);

/** Adds calendar months, keeping the day of the month and clamping to the last day of a shorter month (31 Jan plus 1 is 28 Feb, or 29 in a leap year). Counted from `d`, never month by month. */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${pad(nm)}-${pad(Math.min(day, last))}`;
}
