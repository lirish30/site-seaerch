import { LIVE, testClientSql } from "../clients/record";
import { holdFreeSql } from "../db/holds";
import { liveProjectSql } from "../db/projects";
import { getSettings } from "../db/settings";
import { dueOnFor, zoneOf } from "../sop/cadence";
import { parseWorkConfig } from "../time/config";

/** A week is "near" the limit from this share of it. At the limit itself it is "over". Capacity only warns: nothing is ever blocked. */
export const NEAR_AT = 0.8;
/** A task Claude drafts and you review takes this share of its estimate of your time. */
export const REVIEW_SHARE = 0.25;
const WEEKS = 4;
const DAY = 86_400_000;

export interface CapacityWeek { monday: string; bookedMinutes: number; limitMinutes: number }
export interface Capacity {
  /** This week and the next three, each starting on its Monday in the booking zone. */
  weeks: CapacityWeek[];
  /** The minutes of work that were due before this week's Monday and are still open (they are also counted in this week). */
  carryOverMinutes: number;
  /** Real live clients against the limit you set. */
  clients: { count: number; limit: number };
  /** The worse of this week and next week: near at 80% of the limit, over at 100%. */
  state: "ok" | "near" | "over";
  sentence: string;
}

/** A `YYYY-MM-DD` calendar date moved by whole days (the date itself, with no zone in it). */
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** 14, or 1.5: hours with at most one decimal and no trailing ".0". */
const hours = (minutes: number): string => String(Math.round(minutes / 6) / 10);

/**
 * What is booked of your time in each of this week and the next three. A task counts by its estimate when it is open (to do, in progress or in review), has a due date and belongs to a live,
 * real project of a client with no billing hold: yours in full, one Claude drafts for your review at `REVIEW_SHARE`, Claude's own not at all. Due dates are local dates already, so they are
 * compared with the Mondays of the booking zone as text. Work due before this Monday is overdue: it is added to this week and also reported as `carryOverMinutes`. Logged time is not subtracted.
 */
export async function computeCapacity(db: D1Database, now: Date): Promise<Capacity> {
  const settings = await getSettings(db);
  const cfg = parseWorkConfig(settings.work_config);
  const tz = zoneOf(settings);
  const thisMonday = dueOnFor("weekly", 1, now, tz);
  const mondays = Array.from({ length: WEEKS }, (_, i) => addDays(thisMonday, i * 7));
  const end = addDays(thisMonday, WEEKS * 7);

  const tasks = (await db.prepare(
    `SELECT t.owner, t.est_minutes, t.due_on FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE ${liveProjectSql("p")} AND p.test = 0 AND ${holdFreeSql("t")} AND t.owner IN ('logan', 'claude_drafts')
       AND t.status IN ('todo', 'in_progress', 'in_review') AND t.due_on IS NOT NULL AND t.due_on < ? AND t.est_minutes > 0`,
  ).bind(end).all<{ owner: "logan" | "claude_drafts"; est_minutes: number; due_on: string }>()).results;

  const booked = mondays.map(() => 0);
  let carry = 0;
  for (const t of tasks) {
    const mine = t.owner === "logan" ? t.est_minutes : t.est_minutes * REVIEW_SHARE;
    if (t.due_on < thisMonday) { carry += mine; booked[0] += mine; continue; }
    // The last Monday on or before the due date: the week it is in.
    let w = mondays.length - 1;
    while (w > 0 && t.due_on < mondays[w]) w--;
    booked[w] += mine;
  }

  const limitMinutes = cfg.weeklyHoursLimit * 60;
  const weeks = mondays.map((monday, i) => ({ monday, bookedMinutes: Math.round(booked[i]), limitMinutes }));
  const worst = Math.max(weeks[0].bookedMinutes, weeks[1].bookedMinutes);
  const state = worst >= limitMinutes ? "over" : worst >= limitMinutes * NEAR_AT ? "near" : "ok";

  return {
    weeks, carryOverMinutes: Math.round(carry),
    clients: { count: await liveClientCount(db), limit: cfg.clientLimit },
    state,
    sentence: `This week is ${hours(weeks[0].bookedMinutes)} of ${cfg.weeklyHoursLimit} hours booked; next week ${hours(weeks[1].bookedMinutes)} of ${cfg.weeklyHoursLimit}.`,
  };
}

/** Real live clients: a business with a billing (or late) subscription or a live project, never a test one and never a rehearsal client. */
export async function liveClientCount(db: D1Database): Promise<number> {
  const live = LIVE.map((s) => `'${s}'`).join(", ");
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM businesses b
     WHERE NOT ${testClientSql("b")}
       AND (EXISTS (SELECT 1 FROM subscriptions u WHERE u.business_id = b.id AND u.test = 0 AND u.status IN (${live}))
         OR EXISTS (SELECT 1 FROM projects p WHERE p.business_id = b.id AND p.test = 0 AND ${liveProjectSql("p")}))`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A warning for work you are about to take on: null when this week and next week (with `extraMinutes` added to next week) would both stay under the limit, otherwise one sentence
 * naming the week and the hours. It only warns; the caller never refuses anything because of it.
 */
export async function capacityWarning(db: D1Database, now: Date, extraMinutes: number): Promise<string | null> {
  const cap = await computeCapacity(db, now);
  const limit = cap.weeks[0].limitMinutes;
  const limitHours = hours(limit);
  const thisWeek = cap.weeks[0].bookedMinutes;
  const nextWeek = cap.weeks[1].bookedMinutes + Math.max(0, extraMinutes);
  const over: string[] = [];
  if (thisWeek >= limit) over.push(`this week is already ${hours(thisWeek)} of ${limitHours}`);
  if (nextWeek >= limit) over.push(`next week would be ${hours(nextWeek)} of ${limitHours}`);
  if (over.length === 0) return null;
  // "hours booked" closes the first clause only: "this week is already 20 of 20 hours booked, and next week would be 24 of 20."
  over[0] += " hours booked";
  return `Heads up: ${over.join(", and ")}.`;
}
