import { periodKey } from "./cadence";

/** The month before the one `now` falls in, `YYYY-MM` (what `periodKey("monthly", …)` returns), counted in the booking zone `tz`. Kept apart from the report sweeps so the traffic pull can use it without an import cycle. */
export function previousMonth(now: Date, tz: string): string {
  const [y, m] = periodKey("monthly", now, tz).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
