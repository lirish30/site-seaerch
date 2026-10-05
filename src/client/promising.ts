import { ApiError } from "./api";

/** What a full scan adds on top of the quick scan the Promising queue was built from. */
export const FULL_SCAN_ADDS = "Screenshots, a Google PageSpeed test, an AI design and conversion review, and an email draft.";

export type MinFit = { ok: true; value: number | null } | { ok: false; error: string };

/** The min-fit box: empty means no filter (null-fit leads are kept either way); otherwise a number from 0 to 100. */
export function parseMinFit(text: string): MinFit {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: "Minimum fit must be a number from 0 to 100." };
  return { ok: true, value: Math.round(n) };
}

export const promisingPath = (minFit: number | null) => (minFit === null ? "/leads/promising" : `/leads/promising?minFit=${minFit}`);

/** Inline text for a failed "Run full scan": the API's own message, or a generic fallback. */
export function fullScanErrorText(x: unknown): string {
  return x instanceof ApiError ? x.message : "Couldn't start the full scan.";
}

/** Per-row accessible name so a screen reader can tell the buttons apart. */
export const fullScanLabel = (name: string) => `Run full scan for ${name}`;
