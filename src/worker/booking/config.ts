import { z } from "zod";

export type BookingKind = "discovery" | "recommendation";
/** Call lengths in minutes (Web Kit §8-9): a 20-minute discovery call, a 30-minute recommendation meeting. */
export const DURATION_MIN: Record<BookingKind, number> = { discovery: 20, recommendation: 30 };

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface BookingWindow { weekday: Weekday; start: string; end: string }
export interface BudgetOption { id: string; label: string; minCents: number }

/** Availability and the booking form, stored as JSON in settings.booking_config. Weekday 0 is Sunday; times are "HH:MM", 24-hour, in `timezone`. */
export interface BookingConfig {
  timezone: string;
  windows: BookingWindow[];
  minNoticeHours: number;
  horizonDays: number;
  bufferMin: number;
  slotStepMin: number;
  /** The Quick Fix price: the lowest budget option on the form may not sit below it (spec §9.4). */
  minEngagementCents: number;
  budgetOptions: BudgetOption[];
  timelineOptions: string[];
}

export const DEFAULT_CONFIG: BookingConfig = {
  timezone: "America/Los_Angeles",
  windows: [],
  minNoticeHours: 12,
  horizonDays: 14,
  bufferMin: 10,
  slotStepMin: 20,
  minEngagementCents: 79700,
  budgetOptions: [
    { id: "797-1999", label: "$797–$1,999", minCents: 79700 },
    { id: "2000-4999", label: "$2,000–$4,999", minCents: 200000 },
    { id: "5000-plus", label: "$5,000+", minCents: 500000 },
  ],
  timelineOptions: ["This month", "In 1–3 months", "Just exploring"],
};

const validZone = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:00");
export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const weekday = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]);

export const BookingConfigSchema = z.object({
  timezone: z.string().max(64).refine(validZone, "Unknown time zone"),
  windows: z.array(z.object({ weekday, start: hhmm, end: hhmm })).max(50),
  minNoticeHours: z.number().int().min(1).max(168),
  horizonDays: z.number().int().min(1).max(60),
  bufferMin: z.number().int().min(0).max(60),
  slotStepMin: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30)]),
  minEngagementCents: z.number().int().min(0).max(100_000_000),
  budgetOptions: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(60), minCents: z.number().int().min(0).max(100_000_000) })).max(10),
  timelineOptions: z.array(z.string().min(1).max(60)).max(10),
}).superRefine((c, ctx) => {
  c.windows.forEach((w, i) => {
    if (toMinutes(w.end) <= toMinutes(w.start)) ctx.addIssue({ code: "custom", path: ["windows", i, "end"], message: "A window must end after it starts" });
  });
  if (!c.budgetOptions.length) ctx.addIssue({ code: "custom", path: ["budgetOptions"], message: "Add at least one budget option" });
  else if (Math.min(...c.budgetOptions.map((b) => b.minCents)) < c.minEngagementCents) {
    ctx.addIssue({ code: "custom", path: ["budgetOptions"], message: "The lowest budget option must be at least the minimum engagement" });
  }
}) satisfies z.ZodType<BookingConfig>;

/**
 * Reads settings.booking_config. "" and "{}" give the defaults, and missing keys take their default. A document that no longer validates
 * also gives the defaults, which have no windows: a broken config offers no times rather than wrong ones.
 */
export function parseConfig(raw: string): BookingConfig {
  if (!raw.trim()) return DEFAULT_CONFIG;
  try {
    const r = BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
    return r.success ? r.data : DEFAULT_CONFIG;
  } catch { return DEFAULT_CONFIG; }
}
