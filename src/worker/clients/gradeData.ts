import { calendarDateIn, calendarDaysBetween, addMonths } from "../billing/dates";
import { parseBillingConfig } from "../billing/config";
import { chunks } from "../db/chunks";
import { getGrades } from "../db/grade";
import { getSettings } from "../db/settings";
import { zoneOf } from "../sop/cadence";
import { suggestGrade, type GradeInput, type GradeView } from "./grade";
import { computeHealth, type Health } from "./health";
import { healthInputs } from "./healthData";

// Gathers what `suggestGrade` needs for a set of clients, reading in bulk: five queries per chunk of 50 ids, however many clients there are. Read only.
// Test invoices, test change orders, test projects and test subscriptions are never counted. Months and days are counted on the booking-zone calendar, never UTC.

const DAY = 86_400_000;
/** Ids per chunk: well under D1's bound-parameter cap, as in `healthData.ts`. */
const CHUNK = 50;
const LATE_MONTHS = 12;
const CHANGE_ORDER_MONTHS = 6;

const marks = (xs: unknown[]) => xs.map(() => "?").join(",");

/** What a client with nothing recorded looks like: no revenue, no health data, nothing late, no scope changes, no tenure. */
const empty = (): GradeInput => ({ mrrCents: 0, healthScore: null, lateInvoices12mo: 0, changeOrders6mo: 0, tenureDays: 0 });

/** A health score counts only when something is recorded behind it: a client with no checks and no deduction scores a bare 100 that says nothing, so it is unknown (null). */
export const knownHealthScore = (h: Health): number | null => (h.hasData || h.reasons.length > 0 ? h.score : null);

/**
 * One entry per id asked for, in the order given. `now` decides the windows (the booking-zone calendar date, minus 12 and 6 months).
 * - mrrCents: live (active or past-due), real subscriptions, as the Clients list adds them up.
 * - healthScore: from the same inputs as the health chip (`health` may carry scores already computed for these ids, which saves reading them again); null when nothing is recorded.
 * - lateInvoices12mo: real invoices made in the last 12 months that have a reminder step `r<n>` raised where reminder offset n (1-based, from `settings.billing_config`) falls after the due date.
 *   An invoice counts once however many such steps it has; the early heads-up and the due-day nudge do not make an invoice late, and `pause` is not a reminder.
 * - changeOrders6mo: real change orders with status `signed` made in the last 6 months (a draft, sent, viewed, declined, void or expired one is not scope that happened).
 * - tenureDays: whole days from the earlier of the first real project's start and the first real paid invoice's payment, to today; 0 when there is neither.
 */
export async function gradeInputs(db: D1Database, businessIds: string[], now: Date, health?: Map<string, Health>): Promise<Map<string, GradeInput>> {
  const out = new Map<string, GradeInput>();
  for (const id of businessIds) out.set(id, empty());
  const ids = [...out.keys()];
  if (ids.length === 0) return out;

  const settings = await getSettings(db);
  const zone = zoneOf(settings), today = calendarDateIn(now, zone);
  const offsets = parseBillingConfig(settings.billing_config).reminderOffsets;
  const lateFrom = addMonths(today, -LATE_MONTHS), changeFrom = addMonths(today, -CHANGE_ORDER_MONTHS);
  // The SQL cut is two days wider than the window so a zone offset never drops a row; the zone date decides.
  const wide = (from: string) => new Date(Date.parse(`${from}T00:00:00.000Z`) - 2 * DAY).toISOString();
  const inWindow = (iso: string, from: string) => calendarDateIn(new Date(iso), zone) >= from;
  const at = (id: string) => out.get(id)!;

  const scores = new Map(health ?? []);
  const missing = ids.filter((id) => !scores.has(id));
  if (missing.length > 0) for (const [id, i] of await healthInputs(db, missing, now)) scores.set(id, computeHealth(i));
  for (const id of ids) at(id).healthScore = knownHealthScore(scores.get(id)!);

  for (const part of chunks(ids, CHUNK)) {
    const inList = marks(part);
    const [subs, nudges, orders, projects, paid] = await Promise.all([
      db.prepare(`SELECT business_id, COALESCE(SUM(monthly_cents), 0) AS cents FROM subscriptions WHERE business_id IN (${inList}) AND test = 0 AND status IN ('active', 'past_due') GROUP BY business_id`)
        .bind(...part).all<{ business_id: string; cents: number }>(),
      db.prepare(
        `SELECT i.business_id AS business_id, i.id AS invoice_id, i.created_at AS created_at, n.step AS step
         FROM invoice_nudges n JOIN invoices i ON i.id = n.invoice_id
         WHERE i.business_id IN (${inList}) AND i.test = 0 AND i.created_at >= ? AND n.step LIKE 'r%'`,
      ).bind(...part, wide(lateFrom)).all<{ business_id: string; invoice_id: string; created_at: string; step: string }>(),
      db.prepare(`SELECT business_id, created_at FROM change_orders WHERE business_id IN (${inList}) AND test = 0 AND status = 'signed' AND created_at >= ?`)
        .bind(...part, wide(changeFrom)).all<{ business_id: string; created_at: string }>(),
      db.prepare(`SELECT business_id, MIN(started_at) AS first FROM projects WHERE business_id IN (${inList}) AND test = 0 GROUP BY business_id`)
        .bind(...part).all<{ business_id: string; first: string | null }>(),
      db.prepare(`SELECT business_id, MIN(paid_at) AS first FROM invoices WHERE business_id IN (${inList}) AND test = 0 AND status = 'paid' AND paid_at IS NOT NULL GROUP BY business_id`)
        .bind(...part).all<{ business_id: string; first: string | null }>(),
    ]);

    for (const r of subs.results) at(r.business_id).mrrCents = r.cents;

    const late = new Set<string>();
    for (const r of nudges.results) {
      const n = Number(r.step.slice(1));
      if (!Number.isInteger(n) || !((offsets[n - 1] ?? 0) > 0) || !inWindow(r.created_at, lateFrom)) continue;
      late.add(r.invoice_id);
    }
    // Counted per business from the invoice ids seen above.
    const owner = new Map(nudges.results.map((r) => [r.invoice_id, r.business_id]));
    for (const invoiceId of late) at(owner.get(invoiceId)!).lateInvoices12mo += 1;

    for (const r of orders.results) if (inWindow(r.created_at, changeFrom)) at(r.business_id).changeOrders6mo += 1;

    const firsts = new Map<string, string>();
    for (const r of [...projects.results, ...paid.results]) {
      if (!r.first || Number.isNaN(Date.parse(r.first))) continue;
      const seen = firsts.get(r.business_id);
      if (seen === undefined || Date.parse(r.first) < Date.parse(seen)) firsts.set(r.business_id, r.first);
    }
    for (const [id, first] of firsts) at(id).tenureDays = Math.max(0, calendarDaysBetween(calendarDateIn(new Date(first), zone), today));
  }
  return out;
}

/** The grade of each client as the owner sees it: what they set, and what the rules suggest today with the reasons. One entry per id; an id that is no business reads as no grade. */
export async function gradeViews(db: D1Database, businessIds: string[], now: Date, health?: Map<string, Health>): Promise<Map<string, GradeView>> {
  const [inputs, grades] = await Promise.all([gradeInputs(db, businessIds, now, health), getGrades(db, businessIds)]);
  const out = new Map<string, GradeView>();
  for (const [id, input] of inputs) {
    const g = grades.get(id) ?? { grade: null, note: "", setAt: null };
    const s = suggestGrade(input);
    out.set(id, { grade: g.grade, note: g.note, setAt: g.setAt, suggested: s.grade, reasons: s.reasons });
  }
  return out;
}

/** One client's grade view, from the same reads. */
export async function gradeViewFor(db: D1Database, businessId: string, now: Date, health?: Health): Promise<GradeView> {
  return (await gradeViews(db, [businessId], now, health ? new Map([[businessId, health]]) : undefined)).get(businessId)!;
}
