import { dollars } from "../../client/packagesView";
import { createApproval, type Approval } from "../db/approvals";
import { activityIfChangedStmt } from "../db/activity";
import { getBusiness } from "../db/businesses";
import { getDocument } from "../db/documents";
import type { InvoiceRow } from "../db/invoices";
import { getPackage } from "../db/packages";
import { getSettings } from "../db/settings";
import { getSubscription, listSubscriptions, markSubscription, type Subscription } from "../db/subscriptions";
import { stripeFetch } from "../documents/deposit";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { StripeError, cancelSubscriptionAtPeriodEnd, changeSubscriptionPrice, ensureProduct, stripeMode } from "../stripe/client";
import "../approvals/termNotice"; // the kind must be registered before an approval of it is made
import { draftAndPropose } from "./draft";
import { parseBillingConfig } from "./config";
import { addMonths, calendarDateIn, calendarDaysBetween } from "./dates";
import { existingCare, invoiceRecipient, renderTermNotice, signOff, subscriptionPlanName, type Recipient } from "./mail";

export const TERM_NOTICE_KIND = "subscription.term_notice";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** A reason that is safe to log: one line, never the secret key, never long. */
const safe = (e: unknown, key: string | undefined): string => {
  const raw = e instanceof Error ? e.message : "unknown error";
  return oneLine(key ? raw.split(key).join("[key]") : raw).slice(0, 200);
};

/** Whole calendar months from `from` to `to` (both `YYYY-MM-DD`): the most whole months that fit, counted from `from` the way `addMonths` counts (a 31st clamps to a short month's end). 0 when `to` is not later. */
function wholeMonthsBetween(from: string, to: string): number {
  if (to <= from) return 0;
  let n = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  while (n > 0 && addMonths(from, n) > to) n--;
  return n;
}

/**
 * What a client owes to leave before the end of the term: the whole months still to run to `term_ends_on` times the monthly price, in integer cents. Nothing for a subscription with no term, a
 * term that has ended, or one that is already cancelled or ended. Pure: `today` is a calendar date in the owner's zone.
 */
export function earlyExitCents(sub: Pick<Subscription, "termEndsOn" | "monthlyCents" | "status">, today: string): number {
  if (!sub.termEndsOn || sub.status === "cancelled" || sub.status === "ended") return 0;
  return wholeMonthsBetween(today, sub.termEndsOn) * sub.monthlyCents;
}

/** Cancelling would leave a balance and the caller did not confirm it. `cents` is what would be owed. */
export class EarlyExitError extends Error {
  constructor(readonly cents: number, months: number) {
    super(`Cancelling now owes an early-exit balance of ${dollars(cents)} (${months} whole ${months === 1 ? "month" : "months"} left in the term). Confirm it to go on.`);
    this.name = "EarlyExitError";
  }
}

/** What the client chose for the end of the term: move to Care (the default of the Website Subscription) or nothing (a refresh was chosen, or there is no term to end). False when no live subscription changed. */
export async function setEndAction(db: D1Database, id: string, action: "convert_to_care" | "none"): Promise<boolean> {
  const res = await db.prepare(`UPDATE subscriptions SET end_action = ? WHERE id = ? AND status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due')`).bind(action, id).run();
  return (res.meta.changes ?? 0) === 1;
}

const NEVER_ACTIVE = ["planned", "proposed", "link_sent"] as const;

/**
 * Cancels a subscription. One that never became active (planned, proposed, link sent) is simply closed, with no Stripe call. An active or past-due one first works out the early-exit balance:
 * a balance that is not confirmed throws `EarlyExitError` (nothing is changed). Then Stripe is told to stop at the end of the paid period (the key `cancel:<id>` makes a retry a replay), a balance
 * is drafted as an `early_exit` invoice and put up for approval (never sent from here; its ref `early_exit:<id>` makes a retry find the first), and last the row is marked `cancelled`. Each
 * step is safe to repeat, so a failure part way is finished by calling again. A live key never cancels a test subscription.
 */
export async function cancelSubscription(env: Env, id: string, o: { confirmEarlyExit: boolean; now: Date }): Promise<{ subscription: Subscription; invoice: InvoiceRow | null }> {
  const db = env.DB;
  const sub = await getSubscription(db, id);
  if (!sub) throw new Error("There is no such subscription.");
  if (sub.status === "cancelled" || sub.status === "ended") throw new Error(`This subscription is already ${sub.status}.`);
  const stamp = o.now.toISOString();

  if ((NEVER_ACTIVE as readonly string[]).includes(sub.status)) {
    if (!(await markSubscription(db, id, { status: "cancelled", cancelledAt: stamp }, { from: [...NEVER_ACTIVE] }))) throw new Error("This subscription changed while it was being cancelled. Look at it again.");
    return { subscription: (await getSubscription(db, id)) ?? sub, invoice: null };
  }

  const settings = await getSettings(db);
  const today = calendarDateIn(o.now, zoneOf(settings));
  const owed = earlyExitCents(sub, today);
  const months = owed > 0 ? Math.round(owed / sub.monthlyCents) : 0;
  if (owed > 0 && !o.confirmEarlyExit) throw new EarlyExitError(owed, months);

  const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
  if (!key || !mode) throw new Error("Stripe is not set up: add the Stripe secret key first, then cancel again.");
  if (mode === "live" && sub.test) throw new Error("This is a test subscription and Stripe is in live mode, so it cannot be cancelled there. Switch Stripe to a test key.");
  if (!sub.stripeSubscriptionId) throw new Error("This subscription has no Stripe subscription to cancel.");
  await cancelSubscriptionAtPeriodEnd(stripeFetch({}), key, sub.stripeSubscriptionId, `cancel:${sub.id}`);

  let invoice: InvoiceRow | null = null;
  if (owed > 0) {
    const doc = await getDocument(db, sub.documentId);
    const plan = await subscriptionPlanName(env, sub);
    ({ invoice } = await draftAndPropose(env, {
      businessId: sub.businessId, dealId: doc?.dealId ?? null, documentId: sub.documentId, projectId: sub.projectId, changeOrderId: null, subscriptionId: sub.id,
      kind: "early_exit", ref: `early_exit:${sub.id}`, test: sub.test, description: `Early exit: ${plan}`,
      lines: [{ description: `${months} ${months === 1 ? "month" : "months"} remaining in the term, at ${dollars(sub.monthlyCents)} a month`, amountCents: owed }],
    }));
  }

  if (!(await markSubscription(db, id, { status: "cancelled", cancelledAt: stamp }, { from: ["active", "past_due"] }))) {
    const now = await getSubscription(db, id); // Stripe's own cancellation notice may have got there first: that is the same end
    if (now?.status !== "cancelled") throw new Error("This subscription changed while it was being cancelled. Look at it again.");
  }
  return { subscription: (await getSubscription(db, id)) ?? sub, invoice };
}

/** What the client's notice will be, as far as it can be known before it is approved. */
async function noticePreview(env: Env, sub: Subscription, careCents: number, careContinues: boolean): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  let who: Recipient | null = null, problem = "";
  try { who = await invoiceRecipient(env, sub); } catch (e) { problem = e instanceof Error ? e.message : "no recipient"; }
  const clientName = who?.clientName || (await getBusiness(env.DB, sub.businessId))?.name || "the client";
  const plan = await subscriptionPlanName(env, sub);
  const mail = renderTermNotice(sub, { clientName, contactName: who?.contactName ?? "", yourName: signOff(settings), planName: plan, careMonthlyCents: careCents, careContinues });
  const toLine = !who ? `To: nobody yet (${problem})`
    : sub.test ? `To: ${settings.your_name.trim() || "You"} <${settings.contact_email.trim()}> (a test: nothing goes to ${who.to})`
    : `To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`;
  const preview = [
    toLine, `Subject: ${sub.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    `Plan: ${plan}, ${dollars(sub.monthlyCents)} a month`,
    `Term ends: ${sub.termEndsOn ?? "unknown"}`,
    careContinues ? `Then: Care continues on its own plan at ${dollars(careCents)} a month` : `Then: Care at ${dollars(careCents)} a month (the price in the catalog today)`,
    "", "Nothing is mailed until you approve. To keep the client on a refresh instead, set the subscription to \"client chose a refresh\" and this notice will not go out.",
  ].join("\n");
  return { title: `Send term notice to ${clientName}`.replace(/\s+/g, " ").slice(0, 200), preview };
}

/**
 * Drafts the term notice for one subscription, once. The stamp (`term_notice_sent_at`) is claimed first, in one guarded statement, so of two sweeps at the same moment only one goes on to make the
 * approval; if the approval cannot be made the stamp is taken back so the next sweep tries again. True when this call drafted it.
 */
async function draftNotice(env: Env, sub: Subscription, now: Date): Promise<boolean> {
  const db = env.DB;
  const stamp = now.toISOString();
  const claimed = await db.prepare(
    `UPDATE subscriptions SET term_notice_sent_at = ? WHERE id = ? AND status = 'active' AND end_action = 'convert_to_care' AND term_notice_sent_at IS NULL`,
  ).bind(stamp, sub.id).run();
  if ((claimed.meta.changes ?? 0) !== 1) return false;
  try {
    const own = await existingCare(db, sub);
    const care = own.live ? null : await getPackage(db, "care");
    const careCents = own.live?.monthlyCents ?? care?.priceCents;
    if (careCents === undefined) throw new Error("the Care package is missing from the catalog");
    const { title, preview } = await noticePreview(env, sub, careCents, !!own.live);
    await createApproval(db, { kind: TERM_NOTICE_KIND, title, preview, payload: { subscriptionId: sub.id }, record_type: "business", record_id: sub.businessId, drafted_by: "logan" });
  } catch (e) {
    await db.prepare(`UPDATE subscriptions SET term_notice_sent_at = NULL WHERE id = ? AND term_notice_sent_at = ?`).bind(sub.id, stamp).run();
    throw e;
  }
  return true;
}

/**
 * Handles one subscription whose term has ended. Without a Care row on its document it is moved to Care: the Stripe price is swapped to the catalog's current Care price (no proration; the
 * key `convert:<id>` makes a repeat a replay, so a swap that Stripe made but the row did not record is not made twice), then the row is rewritten in ONE statement guarded on the subscription
 * still being active and still set to convert, with its timeline line in the same batch. When the SAME document already has a Care row, the unique (document, package) index rules the swap out
 * and Care is already billed on its own plan: the Website Subscription is stopped at the end of its paid period (key `end:<id>`) and the row is marked `ended`, one guarded statement with its
 * timeline line (a Care row that is closed gets a line saying nothing moved to Care). A Stripe failure leaves the row as it was, and the next sweep tries again. A live key never touches a
 * test row. False when nothing was converted or ended.
 */
async function convert(env: Env, sub: Subscription): Promise<boolean> {
  const db = env.DB;
  const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
  if (!key || !mode) { console.error("terms: Stripe is not set up, so a subscription that reached the end of its term waits", sub.id); return false; }
  if (sub.test && mode === "live") return false;
  if (!sub.stripeSubscriptionId) { console.error("terms: a subscription at the end of its term has no Stripe subscription", sub.id); return false; }
  const own = await existingCare(db, sub);
  const f = stripeFetch({});
  const plan = oneLine(await subscriptionPlanName(env, sub));

  if (own.live || own.closed) {
    await cancelSubscriptionAtPeriodEnd(f, key, sub.stripeSubscriptionId, `end:${sub.id}`);
    const line = own.live ? "Website subscription term ended; Care continues on the existing plan" : "Website subscription term ended; the Care plan on this document is closed, so nothing moved to Care";
    const [res] = await db.batch([
      db.prepare(`UPDATE subscriptions SET status = 'ended' WHERE id = ? AND status = 'active' AND end_action = 'convert_to_care'`).bind(sub.id),
      activityIfChangedStmt(db, sub.businessId, "note", `${line} (${plan})${sub.test ? " (test)" : ""}`),
    ]);
    return (res.meta.changes ?? 0) === 1;
  }

  const care = await getPackage(db, "care");
  if (!care || !Number.isSafeInteger(care.priceCents) || care.priceCents <= 0) { console.error("terms: no usable Care price in the catalog", sub.id); return false; }
  const product = await ensureProduct(f, key, { packageKey: "care", name: care.name }, "product:care:convert");
  await changeSubscriptionPrice(f, key, { subscriptionId: sub.stripeSubscriptionId, productId: product.id, name: care.name, monthlyCents: care.priceCents }, `convert:${sub.id}`);

  const [res] = await db.batch([
    db.prepare(
      `UPDATE subscriptions SET package_key = 'care', package_version = ?, monthly_cents = ?, end_action = 'none', term_months = NULL, term_ends_on = NULL
       WHERE id = ? AND status = 'active' AND end_action = 'convert_to_care'`,
    ).bind(care.version, care.priceCents, sub.id),
    activityIfChangedStmt(db, sub.businessId, "note", `subscription moved to Care: ${plan} ended its term, now ${dollars(care.priceCents)} a month${sub.test ? " (test)" : ""}`),
  ]);
  return (res.meta.changes ?? 0) === 1;
}

/**
 * The daily term step (wired into the billing sweep by a later task). For every active subscription set to convert to Care: one whose term ends within the notice window (30 days by default)
 * and has not been noticed gets a `subscription.term_notice` approval, stamped first so two sweeps draft one; one whose term end is tomorrow, today or past is converted (see `convert`). A failure of one
 * subscription is logged and does not stop the others. Safe to run again. Returns how many notices were drafted and subscriptions converted by this call.
 */
export async function sweepTerms(env: Env, now: Date): Promise<{ notices: number; converted: number }> {
  const db = env.DB;
  const settings = await getSettings(db);
  const today = calendarDateIn(now, zoneOf(settings));
  const noticeDays = parseBillingConfig(settings.billing_config).termNoticeDays;
  const out = { notices: 0, converted: 0 };
  for (const sub of await listSubscriptions(db, { statuses: ["active"] })) {
    if (sub.endAction !== "convert_to_care" || !sub.termEndsOn) continue;
    try {
      const days = calendarDaysBetween(today, sub.termEndsOn);
      // Stripe bills at noon UTC of the term's last day and the daily cron runs at 13:17 UTC, so "tomorrow" is already after that month's charge: converting then is the last chance before month 25 is billed.
      if (days <= 1) { if (await convert(env, sub)) out.converted++; }
      else if (days <= noticeDays && sub.termNoticeSentAt === null && (await draftNotice(env, sub, now))) out.notices++;
    } catch (e) {
      console.error(`terms: could not ${e instanceof StripeError ? "reach Stripe for" : "handle"} a subscription`, safe(e, env.STRIPE_SECRET_KEY));
    }
  }
  return out;
}
