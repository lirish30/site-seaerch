import { ApiError } from "./api";
import { RADAR_INTERVALS, relativeDay, startErrorText } from "./radar";
import type { Radar } from "./types";

/** GET /api/radar/info: the fixed rules the Radar page states above the list. */
export interface RadarInfo { maxRadars: number; maxPerDay: number; checkAtUtc: { hour: number; minute: number }; monthlyLimitUsd: number }

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "Roofer in Boise, ID": the market a radar watches. */
export const marketName = (r: Pick<Radar, "business_type" | "location">) => `${cap(r.business_type)} in ${r.location}`;
export const intervalLabel = (days: number) => `Every ${days} days`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "1:17 pm UTC" from the hour and minute (UTC) the daily check runs. */
export function checkTimeText({ hour, minute }: RadarInfo["checkAtUtc"]): string {
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"} UTC`;
}
export const monthlyLimitText = (usd: number) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
export const usedText = (used: number, max: number) => `${used} of ${max} radars used`;

/** The interval choices: the standard ones plus this radar's own value if it is something else. */
export const intervalChoices = (current: number) => (RADAR_INTERVALS.includes(current) ? RADAR_INTERVALS : [...RADAR_INTERVALS, current].sort((a, b) => a - b));

export const nextRunText = (r: Radar, now = Date.now()) => (r.enabled ? cap(relativeDay(r.next_run_at, now)) : "Paused");
export const lastRunText = (r: Radar, now = Date.now()) => cap(relativeDay(r.last_run_at, now));

/** What the "Found" column says: a link to the last run's search, or a dash when there was none. */
export function foundText(r: Radar): { text: string; searchId: string } | null {
  if (!r.last_search_id) return null;
  return { text: `${r.newLeadCount} new ${r.newLeadCount === 1 ? "lead" : "leads"}${r.lastSearchStatus === "running" ? " so far" : ""}`, searchId: r.last_search_id };
}

/** The red line under a blocked radar's name ("Blocked by spend limit · retries tomorrow"), or null when its last run was fine. */
export function blockedText(r: Radar, now = Date.now()): string | null {
  if (!r.last_error) return null;
  const why = /spend limit/i.test(r.last_error) ? "Blocked by spend limit" : `Couldn't start: ${r.last_error.length > 70 ? `${r.last_error.slice(0, 69)}…` : r.last_error}`;
  const d = Math.round((new Date(r.next_run_at).getTime() - now) / 86_400_000);
  return `${why} · ${d <= 0 ? "retries today" : d === 1 ? "retries tomorrow" : `next try in ${plural(d, "day")}`}`;
}

export const RESULT_CHOICES = [25, 50, 100, 200];
export const resultChoices = (current: number) => (RESULT_CHOICES.includes(current) ? RESULT_CHOICES : [...RESULT_CHOICES, current].sort((a, b) => a - b));

export interface RadarForm { businessType: string; location: string; intervalDays: number; maxResults: number; radiusKm: number; runNow: boolean }
export const NEW_FORM: RadarForm = { businessType: "", location: "", intervalDays: 30, maxResults: 50, radiusKm: 15, runNow: false };
export const formFromRadar = (r: Radar): RadarForm =>
  ({ businessType: r.business_type, location: r.location, intervalDays: r.interval_days, maxResults: r.max_results, radiusKm: r.radius_km ?? NEW_FORM.radiusKm, runNow: false });

/** The first thing wrong with the form, in the user's words, or null when it can be saved. */
export function formProblem(f: RadarForm, editing: boolean): string | null {
  if (!editing && f.businessType.trim().length < 2) return "Say what kind of business to watch, for example plumber.";
  if (!editing && f.location.trim().length < 2) return "Say where to look, for example Boise, ID.";
  if (!Number.isInteger(f.maxResults) || f.maxResults < 1 || f.maxResults > 200) return "Results per run must be a whole number from 1 to 200.";
  if (!(f.radiusKm >= 1 && f.radiusKm <= 100)) return "The radius must be from 1 to 100 km.";
  return null;
}

/** POST /api/radar body. */
export const createBody = (f: RadarForm) => ({
  location: f.location.trim(), businessType: f.businessType.trim(), radiusKm: f.radiusKm, maxResults: f.maxResults, intervalDays: f.intervalDays, runNow: f.runNow,
});

/** PATCH /api/radar/:id body: only what changed, so saving an untouched form sends nothing. */
export function patchBody(f: RadarForm, r: Radar): Record<string, number> {
  const body: Record<string, number> = {};
  if (f.intervalDays !== r.interval_days) body.intervalDays = f.intervalDays;
  if (f.maxResults !== r.max_results) body.maxResults = f.maxResults;
  if (f.radiusKm !== (r.radius_km ?? NEW_FORM.radiusKm)) body.radiusKm = f.radiusKm;
  return body;
}

/** Text for a failed save or run: spend-limit wording for a 402, the API's own message otherwise. */
export const saveErrorText = (e: unknown, fallback = "Couldn't save the radar.") => (e instanceof ApiError ? startErrorText(e.status, e.message) : fallback);
