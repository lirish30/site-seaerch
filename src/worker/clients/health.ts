// The client health score (Plan 11): one number from 0 to 100 and the plain reasons behind it. Pure: it reads nothing and sends nothing.
// `healthData.ts` gathers the inputs from the database; this file only adds them up.

export interface HealthInput {
  /** A `down` incident is open on one of the client's live sites. */
  openDown: boolean;
  /** Whole days until the soonest domain expiry among the client's live sites (negative once past), or null when none is known. */
  domainDaysLeft: number | null;
  /** The share of checks that were ok over the last 30 days, pooled over the client's sites; null when there were none (unknown, never 0 and never 100). */
  uptime30: number | null;
  /** How many checks `uptime30` is made of. */
  checks30: number;
  overdueInvoices: number;
  held: boolean;
  pastDueSubscription: boolean;
  accessUnresolved: number;
  waitingOnClient: boolean;
}

export type HealthBand = "good" | "watch" | "at_risk";

export interface Health {
  /** An integer from 0 to 100. */
  score: number;
  band: HealthBand;
  /** One plain sentence per deduction, in the order the deductions are taken. */
  reasons: string[];
  /** True when there is at least one check behind the uptime figure; a client with no checks is "unknown", not perfect. */
  hasData: boolean;
}

/** Fewer checks than this say too little about uptime: a few early checks cannot drag the score. */
export const MIN_UPTIME_CHECKS = 20;
export const GOOD_FROM = 80, WATCH_FROM = 60;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const domainReason = (days: number): string =>
  days < 0 ? `Domain expired ${plural(-days, "day")} ago` : days === 0 ? "Domain expires today" : `Domain expires in ${plural(days, "day")}`;

/**
 * Starts at 100 and takes off, each at most once: an open down incident 30; the domain 20 at 7 days or fewer (past included) and 10 at 8 to 30; uptime under 99.0% 20 and under 99.5% 10
 * (only from 20 checks); an overdue invoice 15; billing on hold 25; a failed subscription payment 15; site access still missing 10; waiting on the client 10.
 * Clamped to 0 to 100. 80 or more is good, 60 to 79 watch, under 60 at risk.
 */
export function computeHealth(i: HealthInput): Health {
  let score = 100;
  const reasons: string[] = [];
  const take = (points: number, reason: string) => { score -= points; reasons.push(reason); };

  if (i.openDown) take(30, "Site is down");
  if (i.domainDaysLeft !== null && i.domainDaysLeft <= 7) take(20, domainReason(i.domainDaysLeft));
  else if (i.domainDaysLeft !== null && i.domainDaysLeft <= 30) take(10, domainReason(i.domainDaysLeft));
  if (i.uptime30 !== null && i.checks30 >= MIN_UPTIME_CHECKS) {
    if (i.uptime30 < 99.0) take(20, `Uptime ${i.uptime30}% in 30 days`);
    else if (i.uptime30 < 99.5) take(10, `Uptime ${i.uptime30}% in 30 days`);
  }
  if (i.overdueInvoices > 0) take(15, "An invoice is overdue");
  if (i.held) take(25, "Billing is on hold");
  if (i.pastDueSubscription) take(15, "A subscription payment failed");
  if (i.accessUnresolved > 0) take(10, "Site access is still missing");
  if (i.waitingOnClient) take(10, "Waiting on the client");

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: score >= GOOD_FROM ? "good" : score >= WATCH_FROM ? "watch" : "at_risk", reasons, hasData: i.checks30 > 0 };
}
