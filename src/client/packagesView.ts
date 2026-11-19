import type { Package } from "../worker/db/packages";

export type { Package };

/** Whole dollars from cents, with cents only when they are not zero: 79700 -> "$797", 12950 -> "$129.50". */
export const dollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** "$797", "from $3,997", "$297/mo for 24 months + $497 setup". */
export function formatPrice(p: Pick<Package, "kind" | "priceCents" | "setupCents" | "termMonths" | "altPriceCents" | "fromPrice">): string {
  if (p.kind === "hourly") return `${dollars(p.priceCents)}/hr${p.altPriceCents === null ? "" : ` (${dollars(p.altPriceCents)} for Care clients)`}`;
  if (p.kind === "one_time") return `${p.fromPrice ? "from " : ""}${dollars(p.priceCents)}${p.setupCents > 0 ? ` + ${dollars(p.setupCents)} setup` : ""}`;
  const term = p.termMonths !== null && p.kind === "subscription" ? ` for ${p.termMonths} months` : "";
  const setup = p.setupCents > 0 ? ` + ${dollars(p.setupCents)} setup` : "";
  const first = p.kind === "monthly" && p.termMonths !== null ? `, ${p.termMonths}-month first term` : "";
  return `${dollars(p.priceCents)}/mo${term}${setup}${first}`;
}

/** Warnings to show before a price is saved: a rise of more than 25%, or any fall. Grandfathered prices stay on existing clients. */
export function priceWarnings(before: Pick<Package, "priceCents">, after: Pick<Package, "priceCents">): string[] {
  const b = before.priceCents, a = after.priceCents;
  if (b <= 0 || a === b) return [];
  const pct = Math.round(Math.abs(a - b) / b * 100);
  if (a > b && (a - b) / b > 0.25) return [`The price rises ${pct}% (${dollars(b)} to ${dollars(a)}). Proposals already sent keep the old price.`];
  if (a < b) return [`The price falls ${pct}% (${dollars(b)} to ${dollars(a)}). Existing clients keep the price they signed at.`];
  return [];
}

/** A dollar box ("$1,297", "797.50") to whole cents; null for blank, negative or not a number. */
export function parseDollars(raw: string): number | null {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}
