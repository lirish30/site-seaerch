import type { PackageKey, PackageSnapshot } from "../db/packages";
import { optionTotals, type Option } from "../sales/options";

export interface Milestone { id: string; label: string; dueOn: "signing" | "design_approved" | "site_finished"; amountCents: number }
export interface Recurring {
  key: PackageKey; name: string; monthlyCents: number; startsOn: "signing" | "launch" | "kickoff"; termMonths: number | null;
  /** True when the first month is paid at signing (and counted in the deposit). */
  firstMonthPrepaid: boolean;
}
export interface PaymentSchedule { milestones: Milestone[]; recurring: Recurring[]; depositCents: number }

/** The schedule cannot be made from this option and snapshot (a 400, never a silent fix). */
export class ScheduleError extends Error {}

/** A site build. Care is on by default on every one of these (spec §8). */
export const BUILD_KEYS: PackageKey[] = ["starter_site", "growth_site", "website_subscription"];

type DueOn = Milestone["dueOn"];
interface Rule {
  /** One-time money split as [due, percent] pairs. Shares round down; the remainder goes on the last one. */
  split?: [DueOn, number][];
  /** Recurring billing starts at launch, at kickoff, or (Care-style) at launch when the option builds a site and at signing when it does not. */
  start?: "launch" | "kickoff" | "with_build";
}

/**
 * The whole payment policy, one row per package. These are my calls (spec §8 gives only the Starter and Growth splits and "deposit before
 * work starts"). A package with no row bills its setup fee, if it has one, at signing; a recurring package with no row cannot be scheduled.
 */
const RULES: Partial<Record<PackageKey, Rule>> = {
  quick_fix: { split: [["signing", 100]] },
  starter_site: { split: [["signing", 50], ["site_finished", 50]] },
  growth_site: { split: [["signing", 40], ["design_approved", 30], ["site_finished", 30]] },
  website_subscription: { start: "launch" },
  care: { start: "with_build" },
  care_plus: { start: "with_build" },
  care_fallback: { start: "with_build" },
  client_hosted_surcharge: { start: "with_build" },
  local_seo: { start: "kickoff" },
  local_seo_growth: { start: "kickoff" },
  reviews_addon: { start: "kickoff" },
};

const DUE_ORDER: DueOn[] = ["signing", "design_approved", "site_finished"];
const LABELS: Record<DueOn, string> = { signing: "Deposit at signing", design_approved: "Design approved", site_finished: "Site finished" };

/**
 * What the client pays, and when, for one option at the prices frozen in `snapshot`.
 * Setup discounts come off the one-time amount before the percentages split it. Hourly is a rate, not a charge, so it adds nothing.
 */
export function paymentSchedule(option: Option, snapshot: PackageSnapshot[]): PaymentSchedule {
  const hasBuild = option.items.some((i) => BUILD_KEYS.includes(i.key));
  const due = new Map<DueOn, number>();
  const recurring: Recurring[] = [];

  for (const item of option.items) {
    const p = snapshot.find((s) => s.key === item.key);
    if (!p) throw new ScheduleError(`${item.key} is not in the price snapshot, so it cannot be scheduled.`);
    if (p.kind === "hourly") continue;
    const discount = item.setupDiscountCents ?? 0;
    if (!Number.isInteger(discount) || discount < 0) throw new ScheduleError(`The discount on ${p.name} must be a whole number of cents, zero or more.`);
    const gross = (p.kind === "one_time" ? p.priceCents : 0) + p.setupCents;
    if (discount > gross) throw new ScheduleError(`The discount on ${p.name} is more than the ${gross} cents it comes off.`);
    const net = gross - discount;
    const rule = RULES[item.key];

    if (net > 0) {
      const split = rule?.split ?? [["signing", 100] as [DueOn, number]];
      let given = 0;
      split.forEach(([dueOn, pct], i) => {
        const cents = i === split.length - 1 ? net - given : Math.floor((net * pct) / 100);
        given += cents;
        due.set(dueOn, (due.get(dueOn) ?? 0) + cents);
      });
    }

    if (p.kind === "one_time") continue;
    if (!rule?.start) throw new ScheduleError(`${p.name} has no billing rule, so it cannot be scheduled.`);
    const startsOn: Recurring["startsOn"] = rule.start === "with_build" ? (hasBuild ? "launch" : "signing") : rule.start;
    // A monthly item with nothing due at signing for itself prepays its first month, so the client always pays something before work starts.
    const firstMonthPrepaid = startsOn === "signing" || (rule.start !== "with_build" && net === 0);
    recurring.push({ key: p.key, name: p.name, monthlyCents: p.priceCents, startsOn, termMonths: p.termMonths, firstMonthPrepaid });
  }

  const milestones: Milestone[] = DUE_ORDER.filter((d) => (due.get(d) ?? 0) > 0).map((d) => ({ id: d, label: LABELS[d], dueOn: d, amountCents: due.get(d)! }));
  const depositCents = (due.get("signing") ?? 0) + recurring.filter((r) => r.firstMonthPrepaid).reduce((n, r) => n + r.monthlyCents, 0);
  if (depositCents <= 0) throw new ScheduleError("Nothing is due at signing, so there is no deposit. A deposit is due before any work starts.");
  const total = milestones.reduce((n, m) => n + m.amountCents, 0);
  const upfront = optionTotals(option, snapshot).upfrontCents;
  if (total !== upfront) throw new ScheduleError(`The payment schedule (${total} cents) does not match what the option costs up front (${upfront} cents).`);
  return { milestones, recurring, depositCents };
}
