import type { Capacity } from "../worker/capacity/compute";

/** "14", "1.5": minutes as hours with at most one decimal and no trailing ".0". */
export const hoursText = (minutes: number): string => String(Math.round(minutes / 6) / 10);

/** "Nov 30": the Monday a week starts on, from `YYYY-MM-DD`. */
export function weekLabel(monday: string): string {
  const [y, m, d] = monday.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface CapacityRow { label: string; booked: string; limit: string; pct: number; over: boolean }

/** One row per week for the bars. The bar is capped at the limit; `over` marks a week at or past it. */
export function capacityRows(c: Capacity): CapacityRow[] {
  return c.weeks.map((w, i) => ({
    label: i === 0 ? "This week" : i === 1 ? "Next week" : `Week of ${weekLabel(w.monday)}`,
    booked: hoursText(w.bookedMinutes), limit: hoursText(w.limitMinutes),
    pct: w.limitMinutes > 0 ? Math.min(100, Math.round((w.bookedMinutes / w.limitMinutes) * 100)) : 0,
    over: w.bookedMinutes >= w.limitMinutes,
  }));
}

/** "31 of 45 clients", and whether the count is at the limit or past it. */
export function clientsLine(c: { count: number; limit: number }): { text: string; full: boolean } {
  return { text: `${c.count} of ${c.limit} clients`, full: c.count >= c.limit };
}

/** What the state asks of you, or null when all is well. */
export const stateNote = (s: Capacity["state"]): string | null => s === "over" ? "A week is full. Think before you take on more." : s === "near" ? "A week is nearly full." : null;
