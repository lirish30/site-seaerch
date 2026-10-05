import { ApiError } from "./api";

/** Spend limit input → dollars, or null when blank/invalid (a blank field must never save as $0). */
export function parseSpendLimit(raw: string | number): number | null {
  const t = String(raw).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
}

/** Shown when a per-lead paid action (full scan, re-audit) is refused with a 402. */
export const SPEND_LIMIT_REACHED = "Monthly spend limit reached \u2014 raise it in Settings or wait until next month.";
export const isSpendLimit = (e: unknown) => e instanceof ApiError && e.status === 402;
