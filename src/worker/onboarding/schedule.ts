import type { Onboarding, OnboardingItem } from "../db/onboardings";
import { TERMS } from "../documents/clauses";

/** When an onboarding is due and when the client is nudged. Pure: the caller passes the clock and the owner's time zone. */

/** Days of silence at which reminder levels 1 to 4 become due. */
export const REMINDER_DAYS = [2, 4, 7, 10] as const;
export const QUESTIONNAIRE_DUE_DAYS = 2;
export const PHASE_DUE_DAYS = { 1: 7, 2: 14 } as const;
/** Days without a word from the client after which the contract's silence clause applies. */
export const SILENCE_DAYS = TERMS.silenceDays;

const DAY = 86_400_000;

export type Stage = "welcome" | "questionnaire" | "collecting" | "waiting_on_client" | "complete";

const isComplete = (o: Onboarding, items: OnboardingItem[]) =>
  !!o.closedAt || (!!o.questionnaireSubmittedAt && !items.some((i) => i.status === "waiting"));

/** Whole days since the client last wrote (or, before they have, since the welcome); 0 before the welcome is sent, and never negative. */
export function silentDays(o: Onboarding, now: Date): number {
  if (!o.welcomeSentAt) return 0;
  const since = Date.parse(o.lastClientActivityAt ?? o.welcomeSentAt);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((now.getTime() - since) / DAY));
}

export function stageOf(o: Onboarding, items: OnboardingItem[], now: Date): Stage {
  if (isComplete(o, items)) return "complete";
  if (!o.welcomeSentAt) return "welcome";
  if (silentDays(o, now) >= SILENCE_DAYS) return "waiting_on_client";
  return o.questionnaireSubmittedAt ? "collecting" : "questionnaire";
}

/** The due dates a welcome sent at `sentAt` sets: the questionnaire, and the end of each phase. */
export function dueDatesFor(sentAt: Date): { questionnaireDueAt: string; phaseDue: { 1: string; 2: string } } {
  const plus = (days: number) => new Date(sentAt.getTime() + days * DAY).toISOString();
  return { questionnaireDueAt: plus(QUESTIONNAIRE_DUE_DAYS), phaseDue: { 1: plus(PHASE_DUE_DAYS[1]), 2: plus(PHASE_DUE_DAYS[2]) } };
}

export interface Nudge { key: string; kind: "reminder" | "friday"; level: 1 | 2 | 3 | 4 | null; fridayOf: string | null }

/** The calendar day and weekday of `now` in `tz`, or null when the zone is not one Intl knows. */
function localDay(now: Date, tz: string): { date: string; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
  } catch { return null; }
}

/**
 * What the client is due to hear now. A reminder at level n is due once the silence reaches `REMINDER_DAYS[n-1]`; its key carries the last client write,
 * so the moment the client writes, the ladder starts again under new keys. A Friday nudge is due on a Friday in `tz` while anything is still waiting on
 * the client. Nothing is due before the welcome is sent or once the onboarding is complete. Which keys were already sent is the caller's to know.
 */
export function nudgesDue(o: Onboarding, items: OnboardingItem[], now: Date, tz: string): Nudge[] {
  if (!o.welcomeSentAt || isComplete(o, items)) return [];
  const out: Nudge[] = [];
  const silent = silentDays(o, now);
  REMINDER_DAYS.forEach((days, i) => {
    if (silent < days) return;
    const level = (i + 1) as 1 | 2 | 3 | 4;
    out.push({ key: `reminder:${level}:${o.lastClientActivityAt ?? "none"}`, kind: "reminder", level, fridayOf: null });
  });
  const day = localDay(now, tz);
  const waiting = !o.questionnaireSubmittedAt || items.some((i) => i.status === "waiting");
  if (day?.weekday === "Friday" && waiting) out.push({ key: `friday:${day.date}`, kind: "friday", level: null, fridayOf: day.date });
  return out;
}
