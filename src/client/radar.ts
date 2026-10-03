export const RADAR_INTERVALS = [7, 14, 30, 60, 90];
const DAY = 86400000;

/** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago" — calendar-ish, rounded to whole days. */
export function relativeDay(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const d = Math.round((t - now) / DAY);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** Same wording the New search page uses for a spend-limit 402; other API errors pass through. */
export function startErrorText(status: number, message: string): string {
  return status === 402 ? "This search would go over your monthly spend limit." : message;
}

/** The Radar to create alongside a just-started search. runNow stays false: that search already was the first run. */
export function radarBodyFor(s: { location: string; businessType: string; radiusKm?: number; maxResults: number }, intervalDays: number) {
  return { location: s.location, businessType: s.businessType, radiusKm: s.radiusKm, maxResults: s.maxResults, intervalDays, runNow: false };
}

/** Non-blocking notice when the search started but its Radar could not be saved. */
export function radarFollowUpNotice(status: number, message: string): string {
  const why = status === 409 ? message : status === 401 ? "please sign in again" : message || "unexpected error";
  return `Search started, but the Radar wasn't saved: ${why}.`;
}
