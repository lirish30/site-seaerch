/** Thrown when a template names a merge field the caller gave no value for, so a step is never sent with an unfilled field. */
export class MissingFieldError extends Error {
  constructor(public readonly fields: string[]) {
    super(`missing template field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}`);
    this.name = "MissingFieldError";
  }
}

// A field is `{Word}`: letters, digits and underscores, starting with a letter. Any other brace is literal text.
const FIELD = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * Fills `{Name}`-style fields in one pass (a value that itself looks like a field is not expanded again). Every field
 * with no value, or an empty or blank one, is collected and thrown together. Extra vars are ignored.
 */
export function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  const missing: string[] = [];
  for (const m of tpl.matchAll(FIELD)) {
    if (!vars[m[1]]?.trim() && !missing.includes(m[1])) missing.push(m[1]);
  }
  if (missing.length) throw new MissingFieldError(missing);
  return tpl.replace(FIELD, (_m, name: string) => vars[name]!);
}

/** FNV-1a, 32 bit: small, stable across runtimes, and spreads short ids well enough to split a handful of variants. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The same seed always gets the same variant. An empty list throws: callers must not ask a step with no variants for a body. */
export function pickVariant(variants: string[], seed: string): string {
  if (variants.length === 0) throw new Error("no variants to pick from");
  return variants[hash(seed) % variants.length];
}
