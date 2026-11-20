import { z } from "zod";

/** Invoice terms and the reminder schedule, stored as JSON in settings.billing_config. */
export interface BillingConfig {
  /** Days from sending an invoice to its due date. */
  netDays: number;
  /** Days from the due date at which a reminder is raised (negative is before it), strictly increasing. */
  reminderOffsets: number[];
  /** Days after the due date at which Logan's and Claude's tasks for the client are paused. */
  pauseAfterDays: number;
  /** Days before a subscription's term ends that the client is told it is ending. */
  termNoticeDays: number;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = { netDays: 7, reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14, termNoticeDays: 30 };

export const BillingConfigSchema = z.object({
  netDays: z.number().int().min(1).max(60),
  reminderOffsets: z.array(z.number().int().min(-30).max(60)).min(1).max(6),
  pauseAfterDays: z.number().int().min(7).max(60),
  termNoticeDays: z.number().int().min(7).max(90),
}).superRefine((c, ctx) => {
  if (c.reminderOffsets.some((o, i) => i > 0 && o <= c.reminderOffsets[i - 1])) ctx.addIssue({ code: "custom", path: ["reminderOffsets"], message: "Reminders must come in order, each later than the one before" });
  if (c.pauseAfterDays <= c.reminderOffsets[c.reminderOffsets.length - 1]) ctx.addIssue({ code: "custom", path: ["pauseAfterDays"], message: "The pause must come after the last reminder" });
}) satisfies z.ZodType<BillingConfig>;

/** Reads settings.billing_config. "" and "{}" give the defaults, missing keys take their default, and a document that no longer validates gives the defaults. */
export function parseBillingConfig(raw: string): BillingConfig {
  if (!raw.trim()) return DEFAULT_BILLING_CONFIG;
  try {
    const r = BillingConfigSchema.safeParse({ ...DEFAULT_BILLING_CONFIG, ...JSON.parse(raw) });
    return r.success ? r.data : DEFAULT_BILLING_CONFIG;
  } catch { return DEFAULT_BILLING_CONFIG; }
}
