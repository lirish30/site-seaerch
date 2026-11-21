import { CARE_KEYS, LIVE } from "../clients/record";
import type { Env } from "../env";
import { localDay } from "../monitoring/rollup";

// The edit-hours ledger (Plan 13): how much of a Care client's monthly edit allowance is used. Only time logged on the client's edit-request tasks counts;
// a billable change order or any other billable time, the weekly Care updates (CARE-1) and a Care incident (CARE-5) are other work. A time entry belongs to the month it STARTED in, in the booking zone.

/** The edit time each Care plan includes every month, in minutes. */
export const EDIT_ALLOWANCE_MINUTES: Record<"care" | "care_plus" | "care_fallback", number> = { care: 60, care_plus: 180, care_fallback: 60 };
/** The share of the allowance from which the owner is warned. */
export const WARN_AT = 0.8;

export interface EditLedger {
  /** `YYYY-MM`. */
  month: string;
  allowanceMinutes: number;
  usedMinutes: number;
  /** Whole percent of the allowance used (rounded down), or null when the allowance is 0. */
  percent: number | null;
  /** `ok` below 80%, `warn` from 80% up to the allowance, `over` above it. */
  state: "ok" | "warn" | "over";
}

const DAY = 86_400_000;
const inList = (xs: readonly string[]) => xs.map(() => "?").join(",");

/**
 * The month's edit-time ledger of a client, or null when the client has no live (billing or late) real Care plan. With several, the most generous allowance counts.
 * `tz` is the owner's booking zone; `month` is `YYYY-MM`.
 */
export async function editLedger(env: Pick<Env, "DB">, businessId: string, month: string, tz: string): Promise<EditLedger | null> {
  const plans = (await env.DB.prepare(
    `SELECT package_key FROM subscriptions WHERE business_id = ? AND test = 0 AND status IN (${inList(LIVE)}) AND package_key IN (${inList(CARE_KEYS)})`,
  ).bind(businessId, ...LIVE, ...CARE_KEYS).all<{ package_key: keyof typeof EDIT_ALLOWANCE_MINUTES }>()).results;
  if (!plans.length) return null;
  const allowanceMinutes = Math.max(...plans.map((p) => EDIT_ALLOWANCE_MINUTES[p.package_key]));

  // A local month is at most 14 hours off UTC at either end, so read two days either side and place each entry by its local date.
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 2 * DAY).toISOString();
  const to = new Date(Date.UTC(y, m, 1) + 2 * DAY).toISOString();
  const entries = (await env.DB.prepare(
    `SELECT e.started_at AS started_at, e.minutes AS minutes FROM time_entries e JOIN tasks t ON t.id = e.task_id
     WHERE t.edit_request = 1 AND e.billable = 0 AND t.business_id = ? AND e.business_id = ? AND e.started_at >= ? AND e.started_at < ?`,
  ).bind(businessId, businessId, from, to).all<{ started_at: string; minutes: number }>()).results;
  let usedMinutes = 0;
  for (const e of entries) {
    if (Number.isNaN(Date.parse(e.started_at))) continue;
    if (localDay(e.started_at, tz).slice(0, 7) === month) usedMinutes += e.minutes;
  }

  const percent = allowanceMinutes > 0 ? Math.floor((usedMinutes * 100) / allowanceMinutes) : null;
  const state = usedMinutes > allowanceMinutes ? "over" : allowanceMinutes > 0 && usedMinutes / allowanceMinutes >= WARN_AT ? "warn" : "ok";
  return { month, allowanceMinutes, usedMinutes, percent, state };
}
