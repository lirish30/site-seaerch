/** What a project earned against the time it took. Pure; money is integer cents, time is whole minutes. */

export interface Profit {
  /** Minutes at the cost rate, rounded to a cent. */
  costCents: number;
  /** What was sold, less the cost. */
  marginSoldCents: number;
  /** What has been paid, less the cost. */
  marginPaidCents: number;
  /** Paid cents per hour of work, rounded to a cent; null before any time is logged. */
  effectiveHourlyCents: number | null;
}

export function projectProfit(o: { soldCents: number; paidCents: number; minutes: number; costRateCentsPerHour: number }): Profit {
  const costCents = Math.round((o.minutes * o.costRateCentsPerHour) / 60);
  return {
    costCents,
    marginSoldCents: o.soldCents - costCents,
    marginPaidCents: o.paidCents - costCents,
    effectiveHourlyCents: o.minutes > 0 ? Math.round((o.paidCents * 60) / o.minutes) : null,
  };
}

/**
 * How the time spent compares with the estimate. No estimate (0) is "none". At or under the estimate is "under",
 * up to 10% over is "near", and more than that is "over". The 10% is compared in whole numbers, so 110 of 100 is near and 111 is over.
 */
export function estimateVsActual(estMinutes: number, actualMinutes: number): { deltaMinutes: number; state: "none" | "under" | "near" | "over" } {
  const deltaMinutes = actualMinutes - estMinutes;
  if (estMinutes <= 0) return { deltaMinutes, state: "none" };
  if (actualMinutes <= estMinutes) return { deltaMinutes, state: "under" };
  return { deltaMinutes, state: actualMinutes * 10 <= estMinutes * 11 ? "near" : "over" };
}
