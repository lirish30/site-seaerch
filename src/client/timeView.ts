/** Pure helpers for time: minutes as text, the timer, the timesheet week. Dates here are calendar dates ("2026-11-16") and never touch a time zone. */

/** 65 -> "1h 05m", 45 -> "45m", 0 -> "0m". A negative or broken number reads as zero. */
export function formatMinutes(m: number): string {
  const total = Number.isFinite(m) && m > 0 ? Math.round(m) : 0;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return h === 0 ? `${rest}m` : `${h}h ${String(rest).padStart(2, "0")}m`;
}

/** How long a timer has run: "under a minute", "12m", "1h 05m", and from a day on "1d 2h". Empty for a start that cannot be read. */
export function elapsedLabel(startedAt: string, now: Date): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - start) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return formatMinutes(minutes);
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parts = (day: string): { y: number; m: number; d: number } => {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
};
const utc = (day: string): number => { const { y, m, d } = parts(day); return Date.UTC(y, m - 1, d); };

/** A calendar date moved by whole days. */
export function shiftDay(day: string, days: number): string {
  return new Date(utc(day) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "Mon" and "16" for a calendar date. */
export function dayLabel(day: string): { weekday: string; date: string } {
  return { weekday: WEEKDAY[new Date(utc(day)).getUTCDay()], date: String(parts(day).d) };
}

/** "Nov 16 – 22, 2026", "Nov 30 – Dec 6, 2026", "Dec 28, 2026 – Jan 3, 2027". */
export function weekLabel(days: string[]): string {
  if (days.length === 0) return "";
  const a = parts(days[0]);
  const b = parts(days[days.length - 1]);
  const from = `${MONTH[a.m - 1]} ${a.d}`;
  if (a.y !== b.y) return `${from}, ${a.y} – ${MONTH[b.m - 1]} ${b.d}, ${b.y}`;
  if (a.m !== b.m) return `${from} – ${MONTH[b.m - 1]} ${b.d}, ${b.y}`;
  return `${from} – ${b.d}, ${b.y}`;
}

/** Time against an estimate: "20% over", "on estimate", "25% under", "no estimate". A hair over or under (under half a percent) is on estimate. */
export function varianceLabel(est: number, actual: number): string {
  if (!(est > 0)) return "no estimate";
  const pct = Math.round(((actual - est) / est) * 100);
  if (pct === 0) return "on estimate";
  return pct > 0 ? `${pct}% over` : `${-pct}% under`;
}

/** What Logan types for a length of time, as whole minutes: "90", "90m", "1:30", "1h30", "1h 30m", "1.5h", "2h". Null for anything else, zero, or more than a day. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  let minutes: number | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2}):([0-5]\d)$/))) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = s.match(/^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m?(?:in(?:ute)?s?)?)?$/))) minutes = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
  else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?$/))) minutes = Math.round(Number(m[1]) * 60);
  else if ((m = s.match(/^(\d+)\s*(?:m|min|mins|minutes)?$/))) minutes = Number(m[1]);
  return minutes !== null && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** Today as a calendar date in a time zone ("2026-11-22"); falls back to the browser's zone for a zone it cannot read. */
export function todayIn(tz: string, now: Date = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
}

export interface WeekSummary { total: number; daysWorked: number; busiest: { day: string; minutes: number } | null; byProject: { projectId: string; name: string; minutes: number }[] }

/** What the week adds up to: the total, how many days had any time, the busiest day and time per project (most first). */
export function weekSummary(week: { days: string[]; dayTotals: number[]; total: number; rows: { projectId: string; projectName: string; total: number }[] }): WeekSummary {
  let busiest: WeekSummary["busiest"] = null;
  week.dayTotals.forEach((m, i) => { if (m > 0 && (!busiest || m > busiest.minutes)) busiest = { day: week.days[i], minutes: m }; });
  const map = new Map<string, { projectId: string; name: string; minutes: number }>();
  for (const r of week.rows) {
    const p = map.get(r.projectId) ?? { projectId: r.projectId, name: r.projectName, minutes: 0 };
    p.minutes += r.total;
    map.set(r.projectId, p);
  }
  return { total: week.total, daysWorked: week.dayTotals.filter((m) => m > 0).length, busiest, byProject: [...map.values()].sort((a, b) => b.minutes - a.minutes) };
}
