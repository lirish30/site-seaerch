import { BillingConfigSchema, DEFAULT_BILLING_CONFIG, type BillingConfig as BillingTerms } from "../worker/billing/config";
import { calendarDateIn, calendarDaysBetween } from "../worker/billing/dates";
import type { Hold } from "../worker/db/holds";
import type { InvoiceKind, InvoiceRow } from "../worker/db/invoices";
import type { Subscription } from "../worker/db/subscriptions";
import { dollars } from "./packagesView";

export type { BillingTerms };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A calendar date as owners write it: "2026-12-04" is "4 Dec", or "4 Dec 2026" with `withYear`. Anything that is not a date gives "". */
export function shortDate(ymd: string | null | undefined, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ""}`;
}

// ---- invoices ----

export type StatusTone = "ok" | "wait" | "late" | "bad";
type InvoiceDates = Pick<InvoiceRow, "status" | "dueOn" | "failedOn">;

/** The date the reminders and the hold count from (a failed autopay's day, else the due date), the same as the worker's. */
const baseOf = (i: Pick<InvoiceRow, "dueOn" | "failedOn">): string | null => i.failedOn ?? i.dueOn;

/** Whole days an open invoice is past its due date (0 when it is not, or is not open). `today` is a calendar date in the owner's zone. */
export function daysOverdue(i: InvoiceDates, today: string): number {
  if (i.status !== "open" && i.status !== "failed") return 0;
  const base = baseOf(i);
  return base && base < today ? calendarDaysBetween(base, today) : 0;
}

/** What an invoice's chip says: "Draft, not sent", "Due 4 Dec", "6 days overdue", "Payment failed", "Paid". */
export function invoiceStatusLabel(i: InvoiceDates, today: string): { text: string; tone: StatusTone } {
  switch (i.status) {
    case "draft": return { text: "Draft, not sent", tone: "wait" };
    case "paid": return { text: "Paid", tone: "ok" };
    case "void": return { text: "Voided", tone: "wait" };
    case "uncollectible": return { text: "Written off", tone: "bad" };
    case "failed": return { text: "Payment failed", tone: "bad" };
    case "open": {
      const late = daysOverdue(i, today);
      if (late > 0) return { text: `${plural(late, "day")} overdue`, tone: "late" };
      return i.dueOn ? { text: `Due ${shortDate(i.dueOn)}`, tone: "wait" } : { text: "Sent, no due date", tone: "wait" };
    }
  }
}

/** Void and written-off invoices: nothing more is owed on them, so they are kept apart from the three groups. */
export const isClosedInvoice = (i: Pick<InvoiceRow, "status">): boolean => i.status === "void" || i.status === "uncollectible";

/** Drafts, overdue invoices and failed payments need you; the rest of the sent ones are waiting on the client; paid ones are done. Void and written-off ones are in none (see `isClosedInvoice`). Order is kept. */
export function groupInvoices<R extends InvoiceDates>(rows: R[], today: string): { needsYou: R[]; open: R[]; paid: R[] } {
  const g = { needsYou: [] as R[], open: [] as R[], paid: [] as R[] };
  for (const r of rows) {
    if (r.status === "draft" || r.status === "failed" || daysOverdue(r, today) > 0) g.needsYou.push(r);
    else if (r.status === "open") g.open.push(r);
    else if (r.status === "paid") g.paid.push(r);
  }
  return g;
}

const KIND: Record<InvoiceKind, string> = { deposit: "Deposit", milestone: "Milestone", change_order: "Change order", hourly: "Hours", subscription: "Subscription", early_exit: "Early exit" };
export const invoiceKindLabel = (k: InvoiceKind): string => KIND[k];

// ---- subscriptions ----

type SubTerms = Pick<Subscription, "monthlyCents" | "termMonths" | "termEndsOn" | "firstChargeOn">;

/** "$297/mo, 24-month term to 31 Jan 2028, first charge 1 Feb". The first charge carries its year only when `today` is given and it falls in another year. */
export function subscriptionLine(s: SubTerms, today?: string): string {
  const term = s.termMonths === null ? "no fixed term" : `${s.termMonths}-month term${s.termEndsOn ? ` to ${shortDate(s.termEndsOn, true)}` : ""}`;
  const first = s.firstChargeOn ? `first charge ${shortDate(s.firstChargeOn, !!today && s.firstChargeOn.slice(0, 4) !== today.slice(0, 4))}` : "first charge date not set yet";
  return `${dollars(s.monthlyCents)}/mo, ${term}, ${first}`;
}

/** The plain statement shown in the confirm dialog when a subscription still has months to run. The 409 carries the amount. */
export const earlyExitText = (cents: number): string =>
  `Cancelling now owes an early-exit balance of ${dollars(cents)}, the whole months left in the term. A draft invoice for it is put up for your approval: nothing is charged or sent to the client until you approve it. Cancel anyway?`;

/** The first confirm, before anything is sent. A subscription not yet running is closed with no Stripe call; a running one is told to stop at the end of the period the client has paid for. */
export const cancelSubscriptionText = (plan: string, running: boolean): string =>
  running
    ? `Cancel the ${plan} subscription? Stripe stops billing at the end of the period the client has already paid for. If months are left in the term, you will be shown the balance before anything else happens.`
    : `Cancel the ${plan} subscription? It has not started billing, so nothing is charged and nothing is sent to the client.`;

type SubState = Pick<Subscription, "status" | "startsWhen"> & { linkLost?: boolean };
const STARTS: Record<Subscription["startsWhen"], string> = {
  signing: "Starts by itself once the deposit is paid.", launch: "Starts by itself when the build project is done.", kickoff: "Starts at kickoff: nothing is billed until you press Start billing.",
};
const START_BILLING = "Start billing", PUT_UP_AGAIN = "Put it up again";

/** What happens next with a subscription, and which buttons apply: the start button (`buttonText`: Start billing for a kickoff one, Put it up again for a proposed one of any kind or one whose link never reached the client) and Cancel (until it is over). */
export function subscriptionNext(s: SubState): { text: string; canStart: boolean; buttonText: string; canCancel: boolean; running: boolean } {
  const canCancel = s.status !== "cancelled" && s.status !== "ended";
  const running = s.status === "active" || s.status === "past_due";
  const no = (text: string) => ({ text, canStart: false, buttonText: START_BILLING, canCancel, running });
  switch (s.status) {
    case "planned": return { ...no(STARTS[s.startsWhen]), canStart: s.startsWhen === "kickoff" };
    case "proposed": return s.startsWhen === "kickoff"
      ? { ...no("Waiting for your approval to send the client their subscription link. Start billing again to refresh it."), canStart: true }
      : { ...no("This was proposed but not sent yet."), canStart: true, buttonText: PUT_UP_AGAIN };
    case "link_sent": return s.linkLost
      ? { ...no("The link was never sent, so nothing reached the client."), canStart: true, buttonText: PUT_UP_AGAIN }
      : no("The link was sent. Billing starts when the client sets up their payment.");
    case "active": return no("Billing monthly through Stripe.");
    case "past_due": return no("The last payment failed. Stripe is retrying it.");
    case "cancelled": return no("Cancelled.");
    case "ended": return no("The term has ended.");
  }
}

export const END_ACTIONS: { value: Subscription["endAction"]; label: string }[] = [
  { value: "convert_to_care", label: "Convert to Care" },
  { value: "none", label: "The client chose a refresh" },
];

/** A subscription's status chip. */
export function subscriptionStatusLabel(status: Subscription["status"]): { text: string; tone: StatusTone } {
  switch (status) {
    case "planned": return { text: "Not started", tone: "wait" };
    case "proposed": return { text: "Waiting for your approval", tone: "wait" };
    case "link_sent": return { text: "Link sent", tone: "wait" };
    case "active": return { text: "Active", tone: "ok" };
    case "past_due": return { text: "Payment failed", tone: "bad" };
    case "cancelled": return { text: "Cancelled", tone: "wait" };
    case "ended": return { text: "Ended", tone: "wait" };
  }
}

// ---- holds ----

/** "Work on hold since 1 Dec (9 days)": the day it was placed in the owner's zone, and how long ago. */
export function holdLine(h: Pick<Hold, "placedAt">, today: string, tz: string): string {
  const since = calendarDateIn(new Date(h.placedAt), tz);
  const days = Math.max(0, calendarDaysBetween(since, today));
  return `Work on hold since ${shortDate(since)} (${plural(days, "day")})`;
}

/** The confirm shown before a hold is lifted by hand. It says plainly that the invoice is still unpaid. */
export const liftConfirmText = (client: string, invoice: string, cents: number): string =>
  `${client} has not paid ${invoice} (${dollars(cents)}). Lifting the hold starts the waiting Claude steps again right away, even though the invoice is still unpaid. The hold is recorded as lifted by you. Lift it?`;

// ---- Settings > Billing ----

/** The saved JSON over the defaults. A document that does not parse, or no longer validates, gives the defaults (the worker does the same). */
export function readBillingTerms(raw: string): BillingTerms {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? { ...DEFAULT_BILLING_CONFIG, ...(v as Partial<BillingTerms>) } : { ...DEFAULT_BILLING_CONFIG };
  } catch { return { ...DEFAULT_BILLING_CONFIG }; }
}

/** The reminder days typed in a box ("-3, 0, 3, 7", commas or spaces) as whole numbers; null for blank or anything else. */
export function parseOffsets(raw: string): number[] | null {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
  return parts.map(Number);
}
export const offsetsText = (o: number[]): string => o.join(", ");

const inRange = (n: unknown, lo: number, hi: number): boolean => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** Why these terms cannot be saved, in the worker's own limits and naming the field, or null when the worker would take them. */
export function billingTermsProblem(c: BillingTerms): string | null {
  if (typeof c.netDays === "number" && !Number.isInteger(c.netDays)) return "Days to pay must be a whole number";
  if (!inRange(c.netDays, 1, 60)) return "Days to pay must be from 1 to 60";
  const o = c.reminderOffsets;
  if (!Array.isArray(o) || o.length < 1 || o.length > 6) return "Give from 1 to 6 reminder days";
  if (!o.every((n) => inRange(n, -30, 60))) return "Each reminder day must be a whole number from -30 to 60";
  if (o.some((n, i) => i > 0 && n <= o[i - 1])) return "Reminders must come in order, each later than the one before";
  if (!inRange(c.pauseAfterDays, 7, 60)) return "Pause after must be a whole number of days from 7 to 60";
  if (c.pauseAfterDays <= o[o.length - 1]) return "The pause must come after the last reminder";
  if (!inRange(c.termNoticeDays, 7, 90)) return "The term notice must be a whole number of days from 7 to 90";
  const r = BillingConfigSchema.safeParse(c); // the worker's own check, so nothing it would refuse is let through
  return r.success ? null : r.error.issues[0].message;
}

/** The overview chip for Settings > Billing. */
export function billingTermsSummary(raw: string): { tone: ""; text: string } {
  const c = readBillingTerms(raw);
  return { tone: "", text: `Net ${c.netDays} days, pause after ${c.pauseAfterDays}` };
}

/** What the worker sends about Stripe: a mode and booleans, never a key. */
export interface StripeStatus { mode: "test" | "live" | null; webhookSecretSet: boolean; clientBaseSet: boolean; legalReviewed: boolean }

/** The seven events the webhook handles: turn exactly these on for the endpoint in Stripe. */
export const WEBHOOK_EVENTS = [
  "invoice.paid", "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible", "checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted",
] as const;
export const WEBHOOK_PATH = "/hooks/stripe";

/** The Stripe panel's rows: what is set up, as ok or not, with a plain word for each. */
export function stripeRows(s: StripeStatus): { label: string; ok: boolean; text: string; hint: string }[] {
  return [
    { label: "Stripe key", ok: s.mode !== null, text: s.mode === "live" ? "Live mode" : s.mode === "test" ? "Test mode" : "Not set up", hint: "STRIPE_SECRET_KEY, a Worker secret. Test mode rehearses; live mode makes real charges." },
    { label: "Webhook secret", ok: s.webhookSecretSet, text: s.webhookSecretSet ? "Set" : "Not set", hint: "STRIPE_WEBHOOK_SECRET, a Worker secret. Without it a payment is never noticed." },
    { label: "Client link base", ok: s.clientBaseSet, text: s.clientBaseSet ? "Set" : "Not set", hint: "CLIENT_LINK_BASE (https). Client pages use it, never the Worker's own address." },
    { label: "Lawyer review recorded", ok: s.legalReviewed, text: s.legalReviewed ? "Recorded" : "Not recorded", hint: "Under Settings > Documents. A real subscription link is not sent until the review is recorded." },
  ];
}
