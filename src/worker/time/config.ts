import { z } from "zod";

/** Work settings, stored as JSON in settings.work_config. */
export interface WorkConfig {
  /** What an hour of Logan's time costs, in cents (0 means "do not count my time as a cost"). */
  costRateCentsPerHour: number;
  /** The first day of the timesheet week: 0 is Sunday, 1 is Monday. */
  weekStartsOn: 0 | 1;
  /** A timer left running longer than this many minutes is saved at this length. */
  timerCapMinutes: number;
}

export const DEFAULT_WORK_CONFIG: WorkConfig = { costRateCentsPerHour: 0, weekStartsOn: 1, timerCapMinutes: 720 };

export const WorkConfigSchema = z.object({
  costRateCentsPerHour: z.number("The cost rate must be a number of cents").int("The cost rate must be whole cents").min(0, "The cost rate cannot be negative").max(50_000, "The cost rate is at most $500 an hour"),
  weekStartsOn: z.union([z.literal(0), z.literal(1)], "The week starts on Sunday or Monday"),
  timerCapMinutes: z.number("The timer cap must be a number of minutes").int("The timer cap must be whole minutes").min(60, "The timer cap is at least 60 minutes").max(1440, "The timer cap is at most 1440 minutes"),
}) satisfies z.ZodType<WorkConfig>;

/**
 * Reads settings.work_config. "" and "{}" give the defaults, and missing keys take their default.
 * A document that no longer validates also gives the defaults.
 */
export function parseWorkConfig(raw: string): WorkConfig {
  if (!raw.trim()) return DEFAULT_WORK_CONFIG;
  try {
    const r = WorkConfigSchema.safeParse({ ...DEFAULT_WORK_CONFIG, ...JSON.parse(raw) });
    return r.success ? r.data : DEFAULT_WORK_CONFIG;
  } catch { return DEFAULT_WORK_CONFIG; }
}
