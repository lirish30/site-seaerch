import { z } from "zod";

/** Money settings, stored as JSON in settings.money_config. */
export interface MoneyConfig {
  /** The monthly recurring revenue, in cents, at which Logan is free of needing client work: the freedom number. */
  freedomMrrCents: number;
}

export const DEFAULT_MONEY_CONFIG: MoneyConfig = { freedomMrrCents: 500_000 };

export const MoneyConfigSchema = z.object({
  freedomMrrCents: z.number("The freedom number must be a number of cents").int("The freedom number must be whole cents").min(0, "The freedom number cannot be negative").max(10_000_000, "The freedom number is at most $100,000 a month"),
}) satisfies z.ZodType<MoneyConfig>;

/**
 * Reads settings.money_config. "" and "{}" give the defaults, and missing keys take their default.
 * A document that no longer validates also gives the defaults. The result is always the caller's own copy, never the shared defaults object.
 */
export function parseMoneyConfig(raw: string): MoneyConfig {
  if (!raw.trim()) return { ...DEFAULT_MONEY_CONFIG };
  try {
    const r = MoneyConfigSchema.safeParse({ ...DEFAULT_MONEY_CONFIG, ...JSON.parse(raw) });
    return r.success ? r.data : { ...DEFAULT_MONEY_CONFIG };
  } catch { return { ...DEFAULT_MONEY_CONFIG }; }
}
