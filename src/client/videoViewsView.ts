import { ago } from "./todayHome";

/** The Home card's heading: videos that were watched and have had no answer. */
export const WATCHED_HEADING = "Watched your video, no reply yet";

/** "Watched 50% 5m ago": how far the lead got and when, on the Home card and the lead's video panel. */
export const watchedLine = (w: { maxPct: number; lastAt: string }, now: Date): string => `Watched ${w.maxPct}% ${ago(w.lastAt, now.getTime())}`;

/** The depths the report page reports as the video plays, each once per visit. */
export const PROGRESS_MARKS = [25, 50, 75, 90] as const;

/** Whole percent of the video played so far; 0 while the length is not known yet. */
export function percentPlayed(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !(currentTime > 0)) return 0;
  return Math.min(100, Math.floor((100 * currentTime) / duration));
}

/** The marks `pct` has reached that were not reported yet, lowest first (a jump forward passes several). */
export const crossedMarks = (pct: number, reported: ReadonlySet<number>): number[] => PROGRESS_MARKS.filter((m) => pct >= m && !reported.has(m));
