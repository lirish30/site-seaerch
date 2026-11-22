// The client grade suggestion (Plan 15): A, B or C from a handful of counted facts, and the plain reasons behind it. Pure: it reads nothing, sends nothing and never asks a model.
// `gradeData.ts` gathers the inputs. A grade the owner set is kept on the business row and is never overwritten by a new suggestion; this only says what the rules would pick today.

import type { Grade } from "../db/grade";

export interface GradeInput {
  /** What the client's live, real subscriptions bill each month, in cents. */
  mrrCents: number;
  /** The client health score (0 to 100), or null when nothing is recorded about the client's health yet. */
  healthScore: number | null;
  /** Real invoices from the last 12 months that got as far as a reminder after the due date. */
  lateInvoices12mo: number;
  /** Change orders the client signed in the last 6 months. */
  changeOrders6mo: number;
  /** Whole days the client has been a client (first real project or first paid invoice); 0 when there is nothing to count from. */
  tenureDays: number;
}

export interface GradeSuggestion { grade: Grade; reasons: string[] }

/** A needs at least this much a month ($129, the Care price), at least this long a client, health of this or better, no late invoice and at most one change order. */
export const A_MIN_MRR_CENTS = 12_900;
export const A_MIN_TENURE_DAYS = 60;
export const A_MIN_HEALTH = 80;
/** A takes at most this many change orders in six months. */
export const A_MAX_CHANGE_ORDERS = 1;
/** Under this health score, this many late invoices, or this many change orders, the client is a C. */
export const C_BELOW_HEALTH = 60;
export const C_LATE_INVOICES = 2;
export const C_CHANGE_ORDERS = 3;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dollars = (cents: number) => `$${Math.trunc(cents / 100).toLocaleString("en-US")}`;

/**
 * C is checked first: health under 60, 2 or more late invoices in 12 months, or 3 or more signed change orders in 6 months (any one is enough). Then A, which needs all five: at least
 * $129 a month, health 80 or better (a client with no health data cannot be an A), no late invoice, at most one change order and at least 60 days as a client. Everything else is B, so a
 * client with no revenue and nothing recorded is a B and never an A. The reasons are one plain sentence per rule that decided it, in the order the rules are checked; for a B they are the
 * A conditions it did not meet.
 */
export function suggestGrade(i: GradeInput): GradeSuggestion {
  const cReasons: string[] = [];
  if (i.healthScore !== null && i.healthScore < C_BELOW_HEALTH) cReasons.push(`Health is ${i.healthScore}, under ${C_BELOW_HEALTH}.`);
  if (i.lateInvoices12mo >= C_LATE_INVOICES) cReasons.push(`${plural(i.lateInvoices12mo, "invoice")} paid late in the last 12 months.`);
  if (i.changeOrders6mo >= C_CHANGE_ORDERS) cReasons.push(`${plural(i.changeOrders6mo, "change order")} signed in the last 6 months.`);
  if (cReasons.length > 0) return { grade: "C", reasons: cReasons };

  const missed: string[] = [];
  if (i.mrrCents < A_MIN_MRR_CENTS) {
    missed.push(i.mrrCents <= 0 ? `No monthly revenue yet; an A pays ${dollars(A_MIN_MRR_CENTS)} a month or more.` : `Pays ${dollars(i.mrrCents)} a month; an A pays ${dollars(A_MIN_MRR_CENTS)} or more.`);
  }
  if (i.healthScore === null) missed.push(`No health data yet; an A has health ${A_MIN_HEALTH} or better.`);
  else if (i.healthScore < A_MIN_HEALTH) missed.push(`Health is ${i.healthScore}; an A has ${A_MIN_HEALTH} or better.`);
  if (i.lateInvoices12mo > 0) missed.push(`${plural(i.lateInvoices12mo, "late invoice")} in the last 12 months; an A has none.`);
  if (i.changeOrders6mo > A_MAX_CHANGE_ORDERS) missed.push(`${plural(i.changeOrders6mo, "change order")} signed in the last 6 months; an A has ${A_MAX_CHANGE_ORDERS} or fewer.`);
  if (i.tenureDays < A_MIN_TENURE_DAYS) missed.push(`A client for ${plural(Math.max(0, i.tenureDays), "day")}; an A has been one for ${A_MIN_TENURE_DAYS} or more.`);
  if (missed.length > 0) return { grade: "B", reasons: missed };

  return {
    grade: "A",
    reasons: [
      `Pays ${dollars(i.mrrCents)} a month.`, `Health is ${i.healthScore}.`, "No late invoices in the last 12 months.",
      `${plural(i.changeOrders6mo, "change order")} signed in the last 6 months.`, `A client for ${plural(i.tenureDays, "day")}.`,
    ],
  };
}

/** What the owner sees: the grade they set (null when none), its note and set time, and what the rules suggest today with the reasons. */
export interface GradeView { grade: Grade | null; note: string; setAt: string | null; suggested: Grade; reasons: string[] }
