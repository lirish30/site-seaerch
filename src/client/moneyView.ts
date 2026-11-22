import type { MoneyDashboard } from "../worker/money/dashboard";

/** The view-model of the Money page: pure functions over the dashboard, so the page itself only lays text out. Worker types are imported as types only, so no worker code enters the client bundle. */

/** Dollars from cents: "$1,234" for whole dollars, "$1,234.50" otherwise, "-$5" for a negative. */
export function fmtUsd(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const body = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: abs % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `${cents < 0 && abs > 0 ? "-" : ""}$${body}`;
}

/** Each value as a percent of the largest (one decimal), for a bar's width. A negative value or an all-zero list gives 0. */
export function barWidths(values: number[]): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.round((v / max) * 1000) / 10));
}

/** The money owed, one row per age bucket, in the order the dashboard gives them. */
export function agingRows(ar: Pick<MoneyDashboard["ar"], "buckets">): { label: string; amount: string; count: number }[] {
  return ar.buckets.map((b) => ({ label: b.label, amount: fmtUsd(b.cents), count: b.count }));
}

/** How far MRR is toward the freedom number: "$3,200 of $5,000 a month (64%)", or "Set a target" when there is none. */
export function freedomLine(f: MoneyDashboard["freedom"]): string {
  if (f.targetCents <= 0 || f.pct === null) return "Set a target";
  return `${fmtUsd(f.mrrCents)} of ${fmtUsd(f.targetCents)} a month (${f.pct}%)`;
}

/** "Mar 2027" for "2027-03". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** A dollar amount typed in the target box as whole cents; null when it is not a number of dollars from 0 to 100,000 (the most the server accepts). */
export function targetCentsFrom(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents <= 10_000_000 ? cents : null;
}

/** Running costs are in dollars (they come from usage, not invoices): the share of the cap spent (0 when there is no cap), and a dollar figure as cents for `fmtUsd`. */
export const costPct = (spentUsd: number, limitUsd: number): number => (limitUsd > 0 ? Math.min(100, Math.round((spentUsd / limitUsd) * 100)) : 0);
export const usdToCents = (usd: number): number => Math.round(usd * 100);

/** "4.5 h" for 270 minutes; "0 h" for none. */
export const hoursLabel = (minutes: number): string => `${Math.round((minutes / 60) * 10) / 10} h`;

/** "12 days late" / "1 day late". */
export const daysLate = (days: number): string => `${days} ${days === 1 ? "day" : "days"} late`;

/** Dollars from cents with the cents always shown, for the mono columns of a table: "$2,798.80", "$0.00", "-$12.00". */
export function fmtUsd2(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 && abs > 0 ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "November 2026": the month the figures were taken in, in the booking zone. */
export function monthTitle(asOf: string, zone: string): string {
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return "";
  try { return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: zone }); }
  catch { return d.toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
}

/**
 * The bar chart's geometry: each month's bar as a percent of the plot height, and where the goal line sits (null with no goal). The scale is the larger of the highest month and the goal,
 * so the goal line is always on the plot. A month with nothing has a 0 bar (drawn as a hairline).
 */
export function chartScale(values: number[], goalCents: number): { bars: number[]; goalPct: number | null } {
  const top = Math.max(0, goalCents, ...values);
  if (top === 0) return { bars: values.map(() => 0), goalPct: null };
  return { bars: values.map((v) => (v <= 0 ? 0 : Math.round((v / top) * 1000) / 10)), goalPct: goalCents > 0 ? Math.round((goalCents / top) * 1000) / 10 : null };
}

/** How many more clients like today's average one would close the gap to the goal; null when there is no gap, no client or no MRR to average. */
export function clientsToGoal(mrrCents: number, clients: number, gapCents: number): number | null {
  if (gapCents <= 0 || clients <= 0 || mrrCents <= 0) return null;
  return Math.ceil(gapCents / (mrrCents / clients));
}
