import type { Package, PackageKey } from "../db/packages";

export interface OptionItem { key: PackageKey; setupDiscountCents?: number }
export interface Option { id: "a" | "b" | "c"; label: string; tagline: string; items: OptionItem[]; recommended: boolean }

const CARE_KEYS: PackageKey[] = ["care", "care_plus", "care_fallback"];
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * One-time prices and setup fees (less setup discounts) are paid up front; monthly and subscription prices recur.
 * Quick Fix, Starter and Growth count up front at their listed price. Hourly is a rate, not a sum, so it adds to neither.
 */
export function optionTotals(option: Option, catalog: Package[]): { upfrontCents: number; monthlyCents: number } {
  let upfrontCents = 0, monthlyCents = 0;
  for (const item of option.items) {
    const p = catalog.find((c) => c.key === item.key);
    if (!p) continue;
    if (p.kind === "one_time") upfrontCents += p.priceCents;
    else if (p.kind === "monthly" || p.kind === "subscription") monthlyCents += p.priceCents;
    upfrontCents += p.setupCents - (item.setupDiscountCents ?? 0);
  }
  return { upfrontCents, monthlyCents };
}

/** Human-readable problems with a set of three options; an empty list means it can go out. */
export function validateOptions(options: Option[], ctx: { platform: "wordpress" | "other"; catalog: Package[] }): string[] {
  const problems: string[] = [];
  if (options.length !== 3) problems.push(`There must be exactly three options (there are ${options.length}).`);
  const recommended = options.filter((o) => o.recommended).length;
  if (recommended !== 1) problems.push(`Exactly one option must be recommended (${recommended} are).`);
  else if (options.length >= 2 && !options[1].recommended) problems.push("The recommended option must be the middle one.");

  for (const o of options) {
    const name = o.label.trim() || `Option ${o.id.toUpperCase()}`;
    if (o.items.filter((i) => CARE_KEYS.includes(i.key)).length > 1) problems.push(`${name}: choose only one Care plan.`);
    for (const item of o.items) {
      const p = ctx.catalog.find((c) => c.key === item.key);
      if (!p) { problems.push(`${name}: ${item.key} is not in the catalog.`); continue; }
      if (!p.active) problems.push(`${name}: ${p.name} is not active.`);
      if (!p.publicOffer) problems.push(`${name}: ${p.name} is not offered publicly.`);
      if (p.wordpressOnly && ctx.platform === "other") problems.push(`${name}: ${p.name} is for WordPress sites only.`);
      const d = item.setupDiscountCents;
      if (d === undefined || d === 0) continue;
      const cap = p.setupCents > 0 ? p.setupCents : p.kind === "one_time" ? p.priceCents : 0;
      if (!Number.isInteger(d) || d < 0) problems.push(`${name}: the discount on ${p.name} must be a whole, positive number of cents.`);
      else if (cap === 0) problems.push(`${name}: ${p.name} has no setup fee to discount. Discounts apply only to setup fees, never to monthly prices.`);
      else if (d > cap) problems.push(`${name}: the discount on ${p.name} is more than its ${money(cap)} setup fee.`);
    }
  }
  return problems;
}
