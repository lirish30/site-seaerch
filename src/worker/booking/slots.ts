import type { Interval } from "../google/calendar";
import { DURATION_MIN, toMinutes, type BookingConfig, type BookingKind } from "./config";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in `tz`, as a UTC-style epoch (so "09:00 local" reads as 09:00Z) plus the calendar date. */
function wall(ms: number, tz: string): { asUtc: number; y: number; m: number; d: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { asUtc: Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second), y: p.year, m: p.month, d: p.day };
}

/** The zone's offset from UTC at an instant, in ms (Los Angeles in winter: -8h). */
const offsetAt = (ms: number, tz: string) => wall(Math.floor(ms / 1000) * 1000, tz).asUtc - Math.floor(ms / 1000) * 1000;

/**
 * The UTC instant at which `tz` shows `minutes` past midnight on the calendar date `dayUtc` (a UTC-midnight epoch standing for that date).
 * A wall-clock time that happens twice (fall back) gives the first occurrence. One that never happens (spring forward) gives null,
 * unless `lenient`, which gives the instant the clocks jumped over it (used only for window edges).
 */
export function wallToUtc(dayUtc: number, minutes: number, tz: string, lenient = false): number | null {
  const guess = dayUtc + minutes * MIN;
  const before = offsetAt(guess - DAY, tz), after = offsetAt(guess + DAY, tz);
  const valid = [...new Set([before, after])].map((o) => guess - o).filter((t) => offsetAt(t, tz) === guess - t);
  if (valid.length) return Math.min(...valid);
  return lenient ? guess - before : null;
}

export const dayKey = (ms: number, tz: string) => { const w = wall(ms, tz); return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`; };

/**
 * Every start the booking page may offer, as ascending UTC ISO strings. A start is offered when the whole call sits inside one window
 * (in `cfg.timezone`), starts at least `minNoticeHours` after `now` and at most `horizonDays` after it, lands on the step grid counted from
 * the window start, and keeps `bufferMin` clear on both sides of every busy interval.
 */
export function computeSlots(cfg: BookingConfig, kind: BookingKind, busy: Interval[], now: Date): string[] {
  if (!cfg.windows.length) return [];
  const durationMs = DURATION_MIN[kind] * MIN, bufferMs = cfg.bufferMin * MIN;
  const earliest = now.getTime() + cfg.minNoticeHours * HOUR, latest = now.getTime() + cfg.horizonDays * DAY;
  const today = wall(now.getTime(), cfg.timezone);
  const out = new Set<number>();
  // One day either side of the horizon so a window that straddles a zone offset is never missed; the checks below do the real filtering.
  for (let i = -1; i <= cfg.horizonDays + 1; i++) {
    const dayUtc = Date.UTC(today.y, today.m - 1, today.d + i);
    const weekday = new Date(dayUtc).getUTCDay();
    for (const w of cfg.windows) {
      if (w.weekday !== weekday) continue;
      const startMin = toMinutes(w.start), endMin = toMinutes(w.end);
      const windowStart = wallToUtc(dayUtc, startMin, cfg.timezone, true)!, windowEnd = wallToUtc(dayUtc, endMin, cfg.timezone, true)!;
      for (let m = startMin; m < endMin; m += cfg.slotStepMin) {
        const s = wallToUtc(dayUtc, m, cfg.timezone);
        if (s === null) continue; // a wall-clock time that does not exist today
        const e = s + durationMs;
        if (s < windowStart || e > windowEnd || s < earliest || s > latest) continue;
        if (busy.some((b) => s - bufferMs < b.end && e + bufferMs > b.start)) continue;
        out.add(s);
      }
    }
  }
  return [...out].sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

/** Whether `startIso` is one of the starts `computeSlots` offers right now. Anything that is not a date is not offered. */
export function isOffered(cfg: BookingConfig, kind: BookingKind, busy: Interval[], now: Date, startIso: string): boolean {
  const t = Date.parse(startIso);
  return Number.isFinite(t) && computeSlots(cfg, kind, busy, now).includes(new Date(t).toISOString());
}

/** Two starts to put in an email: the earliest, and the earliest on a different local day (the next slot when every start is on one day). */
export function suggestTwo(slots: string[], tz: string): string[] {
  const sorted = [...slots].sort();
  if (sorted.length < 2) return sorted;
  const first = sorted[0], day = dayKey(Date.parse(first), tz);
  return [first, sorted.find((s) => dayKey(Date.parse(s), tz) !== day) ?? sorted[1]];
}
