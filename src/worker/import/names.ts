/** Case, punctuation, spacing and accent-insensitive form of a business name ("Smith & Sons, Inc." and "SMITH and SONS inc" agree). */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, "");
}

const MIN_CONTAINED = 4; // shorter names would match nearly everything ("Ace" is inside "Ace Hardware" and "Palace Dental")

/** Same normalized name, or one contains the other (both at least 4 characters). */
export function namesSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= MIN_CONTAINED && y.length >= MIN_CONTAINED && (x.includes(y) || y.includes(x));
}
