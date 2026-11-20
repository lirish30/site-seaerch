import type { PackageKey } from "./packages";

export const SUBSCRIPTION_STATUSES = ["planned", "proposed", "link_sent", "active", "past_due", "cancelled", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface Subscription {
  id: string; businessId: string; documentId: string; projectId: string | null; packageKey: PackageKey; packageVersion: number;
  /** Integer cents. */
  monthlyCents: number;
  startsWhen: "signing" | "launch" | "kickoff";
  /** Calendar date (YYYY-MM-DD), or null until it is known. */
  firstChargeOn: string | null;
  termMonths: number | null;
  termEndsOn: string | null;
  endAction: "convert_to_care" | "none";
  status: SubscriptionStatus;
  token: string | null;
  stripeCustomerId: string | null; stripeSubscriptionId: string | null; stripeCheckoutSessionId: string | null;
  termNoticeSentAt: string | null;
  test: boolean;
  createdAt: string; activatedAt: string | null; cancelledAt: string | null;
}

interface Row {
  id: string; business_id: string; document_id: string; project_id: string | null; package_key: PackageKey; package_version: number; monthly_cents: number;
  starts_when: Subscription["startsWhen"]; first_charge_on: string | null; term_months: number | null; term_ends_on: string | null; end_action: Subscription["endAction"];
  status: SubscriptionStatus; token: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_checkout_session_id: string | null;
  term_notice_sent_at: string | null; test: number; created_at: string; activated_at: string | null; cancelled_at: string | null;
}

const toSubscription = (r: Row): Subscription => ({
  id: r.id, businessId: r.business_id, documentId: r.document_id, projectId: r.project_id, packageKey: r.package_key, packageVersion: r.package_version, monthlyCents: r.monthly_cents,
  startsWhen: r.starts_when, firstChargeOn: r.first_charge_on, termMonths: r.term_months, termEndsOn: r.term_ends_on, endAction: r.end_action, status: r.status, token: r.token,
  stripeCustomerId: r.stripe_customer_id, stripeSubscriptionId: r.stripe_subscription_id, stripeCheckoutSessionId: r.stripe_checkout_session_id,
  termNoticeSentAt: r.term_notice_sent_at, test: !!r.test, createdAt: r.created_at, activatedAt: r.activated_at, cancelledAt: r.cancelled_at,
});

async function one(db: D1Database, where: string, value: string): Promise<Subscription | null> {
  const r = await db.prepare(`SELECT * FROM subscriptions WHERE ${where} = ?`).bind(value).first<Row>();
  return r ? toSubscription(r) : null;
}
export const getSubscription = (db: D1Database, id: string) => one(db, "id", id);
export const getSubscriptionByToken = (db: D1Database, token: string) => one(db, "token", token);
export const getSubscriptionByStripeId = (db: D1Database, stripeSubscriptionId: string) => one(db, "stripe_subscription_id", stripeSubscriptionId);

export interface PlannedSubscription {
  businessId: string; documentId: string; projectId: string | null; packageKey: PackageKey; packageVersion: number; monthlyCents: number;
  startsWhen: Subscription["startsWhen"]; firstChargeOn: string | null; termMonths: number | null; termEndsOn: string | null; endAction: Subscription["endAction"]; test: boolean;
}

/** Plans a subscription. One exists per (document, package): a second call for the pair returns the first with `created: false` and changes nothing. */
export async function insertPlanned(db: D1Database, o: PlannedSubscription): Promise<{ subscription: Subscription; created: boolean }> {
  if (!Number.isSafeInteger(o.monthlyCents) || o.monthlyCents <= 0) throw new RangeError("a subscription is for a whole, positive number of cents a month");
  const id = crypto.randomUUID();
  const res = await db.prepare(
    `INSERT INTO subscriptions (id, business_id, document_id, project_id, package_key, package_version, monthly_cents, starts_when, first_charge_on, term_months, term_ends_on, end_action, status, test, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?) ON CONFLICT (document_id, package_key) DO NOTHING`,
  ).bind(id, o.businessId, o.documentId, o.projectId, o.packageKey, o.packageVersion, o.monthlyCents, o.startsWhen, o.firstChargeOn, o.termMonths, o.termEndsOn, o.endAction, o.test ? 1 : 0, new Date().toISOString()).run();
  if ((res.meta.changes ?? 0) === 1) return { subscription: (await getSubscription(db, id))!, created: true };
  const existing = await db.prepare(`SELECT * FROM subscriptions WHERE document_id = ? AND package_key = ?`).bind(o.documentId, o.packageKey).first<Row>();
  if (!existing) throw new Error(`subscription for document ${o.documentId} and package ${o.packageKey} was neither created nor found`);
  return { subscription: toSubscription(existing), created: false };
}

export async function listSubscriptions(db: D1Database, o: { statuses?: SubscriptionStatus[]; businessId?: string } = {}): Promise<Subscription[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (o.statuses) { if (o.statuses.length === 0) return []; where.push(`status IN (${o.statuses.map(() => "?").join(", ")})`); binds.push(...o.statuses); }
  if (o.businessId !== undefined) { where.push("business_id = ?"); binds.push(o.businessId); }
  const rows = (await db.prepare(`SELECT * FROM subscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`).bind(...binds).all<Row>()).results;
  return rows.map(toSubscription);
}

export interface SubscriptionPatch {
  status?: SubscriptionStatus; projectId?: string | null; token?: string | null; stripeCustomerId?: string | null; stripeSubscriptionId?: string | null; stripeCheckoutSessionId?: string | null;
  firstChargeOn?: string | null; termEndsOn?: string | null; termNoticeSentAt?: string | null; activatedAt?: string | null; cancelledAt?: string | null;
}
const COLUMNS: Record<keyof SubscriptionPatch, string> = {
  status: "status", projectId: "project_id", token: "token", stripeCustomerId: "stripe_customer_id", stripeSubscriptionId: "stripe_subscription_id",
  stripeCheckoutSessionId: "stripe_checkout_session_id", firstChargeOn: "first_charge_on", termEndsOn: "term_ends_on", termNoticeSentAt: "term_notice_sent_at",
  activatedAt: "activated_at", cancelledAt: "cancelled_at",
};

/** Patches a row. `from` names the states it may leave, checked in the statement itself so two events racing cannot both make the move. True when a row changed. */
export async function markSubscription(db: D1Database, id: string, patch: SubscriptionPatch, o: { from?: SubscriptionStatus[] } = {}): Promise<boolean> {
  const sets: string[] = [], binds: unknown[] = [];
  for (const k of Object.keys(COLUMNS) as (keyof SubscriptionPatch)[]) if (patch[k] !== undefined) { sets.push(`${COLUMNS[k]} = ?`); binds.push(patch[k]); }
  if (sets.length === 0) return false;
  const from = o.from ?? [];
  const guard = o.from ? (from.length ? ` AND status IN (${from.map(() => "?").join(", ")})` : " AND 0") : "";
  const res = await db.prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?${guard}`).bind(...binds, id, ...from).run();
  return (res.meta.changes ?? 0) === 1;
}

/** What the active and past-due subscriptions bill each month, in integer cents. A rehearsal (test) row is not money, so it is left out. */
export async function sumActiveMonthlyCents(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(monthly_cents), 0) AS total FROM subscriptions WHERE status IN ('active', 'past_due') AND test = 0`).first<{ total: number }>();
  return r?.total ?? 0;
}
