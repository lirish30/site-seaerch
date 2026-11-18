const DAY_MS = 86_400_000;

/** `from` plus `days` calendar days. */
export const addCalendarDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);

/**
 * `from` plus `n` business days: Saturdays and Sundays (UTC) are skipped and no holiday table exists. The time of day is kept.
 * A weekend start counts from the next weekday (Saturday + 1 is Monday).
 */
export function addBusinessDays(from: Date, n: number): Date {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a whole number of days, 0 or more");
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}
