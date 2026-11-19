import { DEFAULT_CONFIG, type BookingConfig } from "../worker/booking/config";
import { dollars } from "./packagesView";

export type { BookingConfig };

/** Sunday first, matching `weekday` (0 = Sunday) in the config. */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Tue, Mar 16, 10:00 AM PDT": a start shown in the viewer's own zone, with the zone named so nobody has to guess. */
export function formatSlot(iso: string, tz: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    .format(new Date(iso)).replace(/[\u202f\u00a0]/g, " ");
}

/** ISO starts grouped by their calendar date in `tz` ("2026-11-24"), in the order given. */
export function groupByDay(slots: string[], tz: string): { day: string; slots: string[] }[] {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: { day: string; slots: string[] }[] = [];
  for (const s of slots) {
    const day = f.format(new Date(s));
    const last = out.at(-1);
    if (last && last.day === day) last.slots.push(s); else out.push({ day, slots: [s] });
  }
  return out;
}

/** The sentence shown under the budget options when they break the minimum-engagement rule, or "" when they are fine. */
export function budgetProblem(options: { minCents: number }[], minEngagementCents: number): string {
  if (!options.length) return "Add at least one budget option.";
  const lowest = Math.min(...options.map((o) => o.minCents));
  return lowest < minEngagementCents ? `The lowest option is ${dollars(lowest)}, below your ${dollars(minEngagementCents)} minimum engagement.` : "";
}

/** The stored JSON as a config: missing keys take their defaults, and anything unreadable gives the defaults (no windows). */
export function readConfig(raw: string): BookingConfig {
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" ? { ...DEFAULT_CONFIG, ...v } : DEFAULT_CONFIG; } catch { return DEFAULT_CONFIG; }
}

/** The first problem with a window, or "" when it is fine. Times are "HH:MM", so comparing the strings compares the times. */
export const windowProblem = (w: { start: string; end: string }): string =>
  !/^\d\d:\d\d$/.test(w.start) || !/^\d\d:\d\d$/.test(w.end) ? "Enter both times." : w.end <= w.start ? "The end must be after the start." : "";

/** What `GET /api/public/report/<token>/book` returns. */
export interface BookPage {
  enabled: boolean; fallbackUrl: string; slots: string[]; tz: string;
  budgetOptions: { id: string; label: string }[]; timelineOptions: string[];
  existing: { start: string; kind: string } | null;
}
/** What a booking answers with: the times, the Meet link and the secret in the cancel link. */
export interface Booked { start: string; end: string; meetUrl: string | null; cancelToken: string }

/** "Tuesday, November 24": a day's heading, in the viewer's zone. */
export const dayHeading = (iso: string, tz: string, locale = "en-US"): string =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));

/** "10:00 AM": a start's time of day, in the viewer's zone. */
export const timeOfDay = (iso: string, tz: string, locale = "en-US"): string =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(/[  ]/g, " ");

/** The page that shows the guest's cancel confirmation (the link they are given). */
export const cancelPath = (token: string, cancelToken: string): string => `/r/${token}/book?cancel=${encodeURIComponent(cancelToken)}`;

/** The Meet link, only when it is https: it came from Google, but the page never trusts a link it is about to render. */
export const safeMeetUrl = (url: string | null): string => (url && url.startsWith("https://") ? url : "");

/** The sentence under the form when a booking is refused, by status. Nothing the person typed is repeated. */
export function bookingError(status: number): string {
  if (status === 409) return "That time was just taken. Pick another one.";
  if (status === 422 || status === 400) return "Please check the form and try again.";
  if (status === 413) return "That is too long. Please shorten your answers.";
  if (status === 404) return "This link isn't available. Reply to the email and we'll sort it out.";
  return "Booking isn't available right now. Please reply to the email and we'll find a time.";
}
