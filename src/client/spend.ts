/** Spend limit input → dollars, or null when blank/invalid (a blank field must never save as $0). */
export function parseSpendLimit(raw: string | number): number | null {
  const t = String(raw).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
}
