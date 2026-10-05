/**
 * Orders the Promising queue: fit desc (a lead with no fit sorts last, never dropped), then opportunity score desc
 * (no score last). `minFit` only removes leads whose fit is a number below it, so an unscored lead is always kept.
 */
export function rankPromising<T extends { fit: { fit: number | null }; score: number | null }>(rows: T[], o: { minFit?: number } = {}): T[] {
  const min = o.minFit ?? null;
  const kept = min === null ? rows : rows.filter((r) => r.fit.fit === null || r.fit.fit >= min);
  const desc = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
  return [...kept].sort((a, b) => desc(a.fit.fit, b.fit.fit) || desc(a.score, b.score));
}
