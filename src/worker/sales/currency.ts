/**
 * Prices come only from the package catalog (global constraint), so a currency amount in text Claude wrote for a prospect-facing page is a refusal unless
 * it is a number the owner themselves gave. This is the one detector, used by the call-prep and call-recap `apply`s.
 */

/** A currency amount: "$500", "500 dollars", "500 USD", "USD 500". Deliberately wide: a refusal is cheap, a stray figure on a deck is not. */
export const CURRENCY = /\$\s?\d|\b\d[\d,.]*\s?(usd|dollars?)\b|\b(usd|dollars?)\s?\d/i;

/** Every currency amount in a text, as three alternatives (the digits after "$", before "usd/dollars", after "usd/dollars"). */
const AMOUNT = /\$\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars?)\b|\b(?:usd|dollars?)\s?(\d[\d,]*(?:\.\d+)?)/gi;

/** A figure as its plain number, without commas or a trailing zero, so "4,500", "4500", "4500.00" and "4,500.50" and "4500.5" compare equal. */
export const figureOf = (s: string): string => {
  const plain = s.replace(/,/g, "");
  const n = Number(plain);
  return plain !== "" && Number.isFinite(n) ? String(n) : plain;
};

/** Every figure typed in a set of texts ("about 4,500 a job" gives "4500"): what the owner gave, for `allowed`. */
export function figuresIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(figureOf(m[0].replace(/[,.]$/, "")));
  return out;
}

/**
 * The reason a set of texts is refused, or null when none carries a currency amount that is not in `allowed` (figures as digits, commas stripped).
 * With an empty `allowed`, any amount at all is refused.
 */
export function refuseCurrency(texts: string[], allowed: Set<string>): string | null {
  for (const text of texts) {
    const first = CURRENCY.exec(text);
    if (!first) continue;
    const found = [...text.matchAll(AMOUNT)];
    // The wide detector saw an amount the figure pattern could not read ("500.dollars"): refused, as no figure can be checked against the owner's.
    if (!found.length) return `it has a price (${first[0].trim()}) that is not a number the owner gave`;
    for (const m of found) {
      const figure = figureOf(m[1] ?? m[2] ?? m[3] ?? "");
      if (!allowed.has(figure)) return `it has a price (${m[0].trim()}) that is not a number the owner gave`;
    }
  }
  return null;
}

/** `refuseCurrency` over named fields: the reason starts with the first field that carries a price, so the refusal says which one to fix. */
export function refuseCurrencyIn(fields: Record<string, string | string[]>, allowed: Set<string>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    const why = refuseCurrency(Array.isArray(value) ? value : [value], allowed);
    if (why) return `${name}: ${why}`;
  }
  return null;
}
