import { calendarDateIn, calendarDaysBetween } from "../billing/dates";
import { clientMrrCents } from "../clients/record";
import type { InvoiceKind, InvoiceRow } from "../db/invoices";
import type { Subscription } from "../db/subscriptions";
import { reminderBase } from "../approvals/invoiceReminder";

/**
 * The money dashboard's figures. Everything here is pure (no clock, no database): the caller passes `now`, the zone and the rows. Money is integer cents; a percentage is rounded to one decimal.
 * Test rows (`test = 1`) never count in any of them; the caller also leaves out the rows of test clients.
 */

const DAY = 86_400_000;
const pct = (part: number, whole: number): number => Math.round((part * 1000) / whole) / 10;

/** The `count` months ending at `endMonth` (YYYY-MM), oldest first. */
function monthsEndingAt(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split("-").map(Number);
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const total = y * 12 + (m - 1) - (count - 1 - i);
    const year = Math.floor(total / 12);
    return `${String(year).padStart(4, "0")}-${String(total - year * 12 + 1).padStart(2, "0")}`;
  });
}

/** Cash received per month: paid, real invoices by the calendar month their `paidAt` falls in, in `zone` (a payment at 11:30 pm on Dec 31 there is December's). Oldest first, a zero for an empty month. */
export function revenueByMonth(invoices: InvoiceRow[], zone: string, endMonth: string, count: number): { month: string; cents: number }[] {
  const totals = new Map(monthsEndingAt(endMonth, count).map((m) => [m, 0]));
  for (const i of invoices) {
    if (i.test || i.status !== "paid" || !i.paidAt) continue;
    const at = new Date(i.paidAt);
    if (Number.isNaN(at.getTime())) continue;
    const month = calendarDateIn(at, zone).slice(0, 7);
    if (totals.has(month)) totals.set(month, totals.get(month)! + i.amountCents);
  }
  return [...totals].map(([month, cents]) => ({ month, cents }));
}

export type AgingKey = "current" | "d1_30" | "d31_60" | "d61_plus";
const BUCKETS: { key: AgingKey; label: string; from: number }[] = [
  { key: "current", label: "Current", from: 0 }, { key: "d1_30", label: "1-30 days late", from: 1 }, { key: "d31_60", label: "31-60 days late", from: 31 }, { key: "d61_plus", label: "61+ days late", from: 61 },
];

/**
 * What is owed: real invoices that are open or failed, by days overdue against `today` (a calendar date in the booking zone). The due date is `reminderBase` (the day an autopay invoice first failed, else
 * its due date), the same one the reminders and `GET /api/billing/summary` count from; no date means current. `oldest` is the ten most overdue invoices (only ones past due, most days first).
 */
export function arAging(invoices: InvoiceRow[], today: string): {
  openCents: number; buckets: { key: AgingKey; label: string; cents: number; count: number }[]; oldest: { invoiceId: string; businessId: string; amountCents: number; daysOverdue: number }[];
} {
  const buckets = BUCKETS.map((b) => ({ key: b.key, label: b.label, cents: 0, count: 0 }));
  const late: { invoiceId: string; businessId: string; amountCents: number; daysOverdue: number }[] = [];
  let openCents = 0;
  for (const i of invoices) {
    if (i.test || (i.status !== "open" && i.status !== "failed")) continue;
    const base = reminderBase(i);
    const daysOverdue = base ? Math.max(0, calendarDaysBetween(base, today)) : 0;
    const idx = BUCKETS.reduce((hit, b, n) => (daysOverdue >= b.from ? n : hit), 0);
    buckets[idx].cents += i.amountCents;
    buckets[idx].count += 1;
    openCents += i.amountCents;
    if (daysOverdue > 0) late.push({ invoiceId: i.id, businessId: i.businessId, amountCents: i.amountCents, daysOverdue });
  }
  late.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountCents - a.amountCents || (a.invoiceId < b.invoiceId ? -1 : 1));
  return { openCents, buckets, oldest: late.slice(0, 10) };
}

/**
 * MRR lost to cancellations in the last 30 days, and that as a share of what was billing at the start (current MRR plus the churned MRR); null when that is 0.
 * Only an explicit cancellation counts (`status = 'cancelled'` with a `cancelledAt`): `ended` is a term that ran out, not a client leaving. The window is [now - 30 days, now], both ends inclusive,
 * so a subscription cancelled exactly 30 days ago counts and one cancelled a second earlier does not.
 */
export function churn(subs: Subscription[], now: Date): { churnedLast30Cents: number; churnRatePct: number | null } {
  const from = now.getTime() - 30 * DAY;
  const churnedLast30Cents = subs
    .filter((s) => {
      if (s.test || s.status !== "cancelled" || !s.cancelledAt) return false;
      const at = Date.parse(s.cancelledAt);
      return at >= from && at <= now.getTime();
    })
    .reduce((sum, s) => sum + s.monthlyCents, 0);
  const base = clientMrrCents(subs) + churnedLast30Cents;
  return { churnedLast30Cents, churnRatePct: base > 0 ? pct(churnedLast30Cents, base) : null };
}

const BILLED_KINDS: readonly InvoiceKind[] = ["deposit", "milestone", "change_order"];

/**
 * Money that is signed but not yet invoiced. Each signed proposal (its one-time milestones) and each signed change order (its price) is booked; the invoices made for it (open, failed or paid; a draft or void one
 * is not billing yet) are billed. The proposal is billed by its deposit and milestone invoices, the change order by its own invoice. What is left is never below 0 for an item, so billing more than was booked on one
 * cannot hide money still unbilled on another. Rows are per client, largest first: `bookedCents` and `billedCents` are the sums as they stand (so an overbilled item shows its true billed), and `cents` is the sum of what each item has left.
 * Subscriptions are not in it.
 */
export function bookedNotBilled(o: {
  documents: { id: string; dealId: string; businessId: string; milestoneCents: number }[];
  signedOrders: { id: string; businessId: string; priceCents: number }[];
  invoices: InvoiceRow[];
}): { cents: number; rows: { businessId: string; bookedCents: number; billedCents: number; cents: number }[] } {
  const billing = o.invoices.filter((i) => !i.test && BILLED_KINDS.includes(i.kind) && (i.status === "open" || i.status === "failed" || i.status === "paid"));
  const byDocument = new Map<string, number>(), byOrder = new Map<string, number>();
  for (const i of billing) {
    if (i.kind === "change_order") { if (i.changeOrderId) byOrder.set(i.changeOrderId, (byOrder.get(i.changeOrderId) ?? 0) + i.amountCents); }
    else if (i.documentId) byDocument.set(i.documentId, (byDocument.get(i.documentId) ?? 0) + i.amountCents);
  }
  const rows = new Map<string, { businessId: string; bookedCents: number; billedCents: number; cents: number }>();
  const add = (businessId: string, bookedCents: number, billedCents: number) => {
    const row = rows.get(businessId) ?? { businessId, bookedCents: 0, billedCents: 0, cents: 0 };
    row.bookedCents += bookedCents;
    row.billedCents += billedCents;
    row.cents += Math.max(0, bookedCents - billedCents);
    rows.set(businessId, row);
  };
  for (const d of o.documents) if (d.milestoneCents > 0) add(d.businessId, d.milestoneCents, byDocument.get(d.id) ?? 0);
  for (const c of o.signedOrders) if (c.priceCents > 0) add(c.businessId, c.priceCents, byOrder.get(c.id) ?? 0);
  const list = [...rows.values()].sort((a, b) => b.cents - a.cents || (a.businessId < b.businessId ? -1 : 1));
  return { cents: list.reduce((sum, r) => sum + r.cents, 0), rows: list };
}

/** MRR against the freedom number. `pct` is null for a target of 0 (nothing to measure against) and may pass 100; `gapCents` is what is still missing, never negative. */
export function freedomProgress(mrrCents: number, targetCents: number): { targetCents: number; mrrCents: number; pct: number | null; gapCents: number } {
  return { targetCents, mrrCents, pct: targetCents > 0 ? pct(mrrCents, targetCents) : null, gapCents: Math.max(0, targetCents - mrrCents) };
}
