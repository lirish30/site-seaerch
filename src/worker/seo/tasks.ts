import { tickChecklist } from "../care/tasks";
import type { Env } from "../env";

// Ticking the client's monthly SEO-1 task (Plan 14). Same rules as the Care report's: idempotent, never un-ticks, and an error is logged and swallowed so it can never break the sweep or the report.

/** The monthly Local SEO cycle's recurring task. It is never worked through the generic step queue: the SEO sweep and the report approval tick it, and its drafts have their own jobs. */
export const SEO_1 = "SEO-1";
export type Seo1Step = "1.1" | "1.7";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Ticks SEO-1 steps (1.1 the data pull, 1.7 the report approved and sent) on the client's monthly task of `period` (the month the task is for, as `YYYY-MM`). Does nothing for a task that is done or
 * skipped, and nothing when the template or the task no longer lines up. Never un-ticks. Returns whether anything changed; an error is logged and swallowed (false).
 */
export async function tickSeo1(env: Env, businessId: string, period: string, steps: Seo1Step[], now: Date): Promise<boolean> {
  try {
    return await tickChecklist(env, SEO_1, businessId, period, steps, now);
  } catch (e) {
    console.error("seo tasks: could not tick the monthly task", msg(e));
    return false;
  }
}
