export const INVOICE_KINDS = ["deposit", "milestone", "change_order", "hourly", "subscription", "early_exit"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
/** draft: made but not yet approved, so no Stripe object exists. open: sent through Stripe and unpaid. failed: a payment attempt did not go through (it can still be paid later). */
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible" | "failed";

/** One line of an invoice. Integer cents. */
export interface InvoiceLine { description: string; amountCents: number }

export interface InvoiceRow {
  id: string; businessId: string; dealId: string | null; documentId: string | null; projectId: string | null; changeOrderId: string | null; subscriptionId: string | null;
  kind: InvoiceKind;
  /** The invoice's own idempotency key (deposit:<document>, ...): one row per ref, and the key of every Stripe call made for it. */
  ref: string;
  /** True for a test copy: it never makes a live charge. */
  test: boolean;
  description: string; lines: InvoiceLine[];
  /** Null on a draft: no Stripe object exists until it is approved. */
  stripeCustomerId: string | null; stripeInvoiceId: string | null;
  /** Integer cents: the sum of the lines. */
  amountCents: number; status: InvoiceStatus; hostedUrl: string | null;
  /** Calendar dates (YYYY-MM-DD) in the booking time zone. */
  dueOn: string | null; sentAt: string | null; failedOn: string | null;
  mismatch: string | null; createdAt: string; paidAt: string | null;
}

/** An invoice made at Stripe (open when it was inserted, with its Stripe ids and link): what a deposit is once it is sent. */
export type SentInvoice = InvoiceRow & { dealId: string; documentId: string; stripeCustomerId: string; stripeInvoiceId: string; hostedUrl: string };

interface Row {
  id: string; business_id: string; deal_id: string | null; document_id: string | null; project_id: string | null; change_order_id: string | null; subscription_id: string | null;
  kind: InvoiceKind; ref: string; test: number; description: string; lines: string; stripe_customer_id: string | null; stripe_invoice_id: string | null;
  amount_cents: number; status: InvoiceStatus; hosted_url: string | null; due_on: string | null; sent_at: string | null; failed_on: string | null;
  mismatch: string | null; created_at: string; paid_at: string | null;
}

function parseLines(raw: string): InvoiceLine[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map((l) => ({ description: String(l?.description ?? ""), amountCents: Number(l?.amountCents) })) : [];
  } catch { return []; }
}

const toInvoice = (r: Row): InvoiceRow => ({
  id: r.id, businessId: r.business_id, dealId: r.deal_id, documentId: r.document_id, projectId: r.project_id, changeOrderId: r.change_order_id, subscriptionId: r.subscription_id,
  kind: r.kind, ref: r.ref, test: !!r.test, description: r.description, lines: parseLines(r.lines), stripeCustomerId: r.stripe_customer_id, stripeInvoiceId: r.stripe_invoice_id,
  amountCents: r.amount_cents, status: r.status, hostedUrl: r.hosted_url, dueOn: r.due_on, sentAt: r.sent_at, failedOn: r.failed_on,
  mismatch: r.mismatch, createdAt: r.created_at, paidAt: r.paid_at,
});

const wholeCents = (n: number) => Number.isSafeInteger(n) && n > 0;

export async function getInvoice(db: D1Database, id: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(id).first<Row>();
  return r ? toInvoice(r) : null;
}

export async function getInvoiceByRef(db: D1Database, ref: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE ref = ?`).bind(ref).first<Row>();
  return r ? toInvoice(r) : null;
}

/** The document's deposit invoice (the one invoice of that kind a document can have). */
export async function getInvoiceForDocument(db: D1Database, documentId: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE document_id = ? AND kind = 'deposit'`).bind(documentId).first<Row>();
  return r ? toInvoice(r) : null;
}

/** Invoices, newest first. An empty `statuses` or `kinds` list matches nothing. */
export async function listInvoices(db: D1Database, o: { statuses?: InvoiceStatus[]; kinds?: InvoiceKind[]; businessId?: string; projectId?: string } = {}): Promise<InvoiceRow[]> {
  const where: string[] = [], binds: unknown[] = [];
  if (o.statuses) { if (o.statuses.length === 0) return []; where.push(`status IN (${o.statuses.map(() => "?").join(", ")})`); binds.push(...o.statuses); }
  if (o.kinds) { if (o.kinds.length === 0) return []; where.push(`kind IN (${o.kinds.map(() => "?").join(", ")})`); binds.push(...o.kinds); }
  if (o.businessId !== undefined) { where.push("business_id = ?"); binds.push(o.businessId); }
  if (o.projectId !== undefined) { where.push("project_id = ?"); binds.push(o.projectId); }
  const rows = (await db.prepare(`SELECT * FROM invoices${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`).bind(...binds).all<Row>()).results;
  return rows.map(toInvoice);
}

/** What a deal has actually paid: the sum of its paid invoices, in integer cents (0 when none). */
export async function paidTotalForDeal(db: D1Database, dealId: string): Promise<number> {
  const r = await db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoices WHERE deal_id = ? AND status = 'paid'`).bind(dealId).first<{ total: number }>();
  return r?.total ?? 0;
}

/** What a document has paid in invoices of the given kinds, in integer cents (0 when none, or when `kinds` is empty). */
export async function paidTotalForDocument(db: D1Database, documentId: string, kinds: InvoiceKind[]): Promise<number> {
  if (kinds.length === 0) return 0;
  const r = await db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoices WHERE document_id = ? AND status = 'paid' AND kind IN (${kinds.map(() => "?").join(", ")})`)
    .bind(documentId, ...kinds).first<{ total: number }>();
  return r?.total ?? 0;
}

export async function getInvoiceByStripeId(db: D1Database, stripeInvoiceId: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE stripe_invoice_id = ?`).bind(stripeInvoiceId).first<Row>();
  return r ? toInvoice(r) : null;
}

/**
 * A new draft invoice: nothing is made at Stripe until it is approved. Its amount is the sum of its lines. A ref is used once: a second call with the same ref
 * returns the first row with `created: false` and changes nothing. A second deposit for a document throws (the unique index), as does any invalid row.
 */
export async function insertDraftInvoice(db: D1Database, o: {
  businessId: string; dealId: string | null; documentId: string | null; projectId: string | null; changeOrderId: string | null; subscriptionId: string | null;
  kind: InvoiceKind; ref: string; test: boolean; description: string; lines: InvoiceLine[];
}): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (o.lines.length === 0 || !o.lines.every((l) => wholeCents(l.amountCents))) throw new RangeError("an invoice line is for a whole, positive number of cents");
  const amountCents = o.lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (!wholeCents(amountCents)) throw new RangeError("an invoice is for a whole, positive number of cents");
  const id = crypto.randomUUID();
  const res = await db.prepare(
    `INSERT INTO invoices (id, business_id, deal_id, document_id, project_id, change_order_id, subscription_id, kind, ref, test, description, lines, amount_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?) ON CONFLICT (ref) DO NOTHING`,
  ).bind(id, o.businessId, o.dealId, o.documentId, o.projectId, o.changeOrderId, o.subscriptionId, o.kind, o.ref, o.test ? 1 : 0, o.description, JSON.stringify(o.lines), amountCents, new Date().toISOString()).run();
  if ((res.meta.changes ?? 0) === 1) return { invoice: (await getInvoice(db, id))!, created: true };
  const existing = await getInvoiceByRef(db, o.ref);
  if (!existing) throw new Error(`invoice ${o.ref} was neither created nor found`);
  return { invoice: existing, created: false };
}

/**
 * A new deposit invoice that already exists at Stripe, open. A document has one: a second insert for it, or a reused Stripe invoice id or ref, throws (the unique indexes).
 * `ref`, `description`, `test` and `lines` default to the deposit's own (deposit:<document>, "Deposit", a real row, one line for the whole amount).
 */
export async function insertInvoice(db: D1Database, o: {
  businessId: string; dealId: string; documentId: string; kind: "deposit"; stripeCustomerId: string; stripeInvoiceId: string; amountCents: number; hostedUrl: string;
  ref?: string; description?: string; test?: boolean; lines?: InvoiceLine[];
}): Promise<SentInvoice> {
  if (!wholeCents(o.amountCents)) throw new RangeError("an invoice is for a whole, positive number of cents");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const description = o.description ?? "Deposit";
  await db.prepare(
    `INSERT INTO invoices (id, business_id, deal_id, document_id, kind, ref, test, description, lines, stripe_customer_id, stripe_invoice_id, amount_cents, status, hosted_url, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).bind(
    id, o.businessId, o.dealId, o.documentId, o.kind, o.ref ?? `deposit:${o.documentId}`, o.test ? 1 : 0, description, JSON.stringify(o.lines ?? [{ description, amountCents: o.amountCents }]),
    o.stripeCustomerId, o.stripeInvoiceId, o.amountCents, o.hostedUrl, now, now,
  ).run();
  return (await getInvoice(db, id)) as SentInvoice;
}

/** A draft that has been approved and made at Stripe becomes open, with its Stripe ids, link and due date. Guarded in the statement: true only when it was still a draft. */
export async function attachStripeInvoice(db: D1Database, id: string, o: { stripeCustomerId: string; stripeInvoiceId: string; hostedUrl: string; dueOn: string | null; now: string }): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE invoices SET stripe_customer_id = ?, stripe_invoice_id = ?, hosted_url = ?, due_on = ?, sent_at = ?, status = 'open' WHERE id = ? AND status = 'draft'`,
  ).bind(o.stripeCustomerId, o.stripeInvoiceId, o.hostedUrl, o.dueOn, o.now, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Throws a draft away (it becomes void). True only when it was a draft: an invoice that exists at Stripe is voided there, never here. */
export async function discardDraftInvoice(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ? AND status = 'draft'`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

export interface InvoicePatch { status?: InvoiceStatus; mismatch?: string | null; paidAt?: string | null; hostedUrl?: string; dueOn?: string | null; failedOn?: string | null }

/**
 * Patches a row. `notFrom` names the states it must not leave, checked in the statement itself so two events racing cannot undo each other.
 * True when a row changed.
 */
export async function markInvoice(db: D1Database, id: string, patch: InvoicePatch, opts: { notFrom?: InvoiceStatus[] } = {}): Promise<boolean> {
  const sets: string[] = [], binds: unknown[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); binds.push(patch.status); }
  if (patch.mismatch !== undefined) { sets.push("mismatch = ?"); binds.push(patch.mismatch); }
  if (patch.paidAt !== undefined) { sets.push("paid_at = ?"); binds.push(patch.paidAt); }
  if (patch.hostedUrl !== undefined) { sets.push("hosted_url = ?"); binds.push(patch.hostedUrl); }
  if (patch.dueOn !== undefined) { sets.push("due_on = ?"); binds.push(patch.dueOn); }
  if (patch.failedOn !== undefined) { sets.push("failed_on = ?"); binds.push(patch.failedOn); }
  if (sets.length === 0) return false;
  const notFrom = opts.notFrom ?? [];
  const guard = notFrom.length ? ` AND status NOT IN (${notFrom.map(() => "?").join(", ")})` : "";
  const res = await db.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?${guard}`).bind(...binds, id, ...notFrom).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function getStripeCustomer(db: D1Database, businessId: string): Promise<string | null> {
  const r = await db.prepare(`SELECT stripe_customer_id FROM stripe_customers WHERE business_id = ?`).bind(businessId).first<{ stripe_customer_id: string }>();
  return r?.stripe_customer_id ?? null;
}

/** Keeps the first customer saved for a business and returns the one now stored (two requests creating one at once agree on the winner). */
export async function saveStripeCustomer(db: D1Database, businessId: string, stripeCustomerId: string): Promise<string> {
  await db.prepare(`INSERT OR IGNORE INTO stripe_customers (business_id, stripe_customer_id, created_at) VALUES (?, ?, ?)`)
    .bind(businessId, stripeCustomerId, new Date().toISOString()).run();
  return (await getStripeCustomer(db, businessId))!;
}

/** Inserts an event claim (not yet processed). False when the id was already there. */
export async function recordEvent(db: D1Database, eventId: string, type: string, now: Date = new Date()): Promise<boolean> {
  const res = await db.prepare(`INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)`).bind(eventId, type, now.toISOString()).run();
  return (res.meta.changes ?? 0) === 1;
}

/** How long a claim on an event holds before another delivery may take it over. */
export const EVENT_LEASE_MS = 2 * 60_000;
/** A released claim is dated here, so the next delivery finds it expired. */
export const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Claims a webhook event for handling. `claimed`: this caller handles it. `duplicate`: it was already handled. `busy`: another delivery holds a fresh claim.
 * An unfinished claim older than the lease is taken over with a conditional update, so of several deliveries racing for it exactly one wins.
 */
export async function claimEvent(db: D1Database, eventId: string, type: string, now: Date = new Date()): Promise<"claimed" | "duplicate" | "busy"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await recordEvent(db, eventId, type, now)) return "claimed";
    const row = await db.prepare(`SELECT received_at, processed_at FROM stripe_events WHERE id = ?`).bind(eventId).first<{ received_at: string; processed_at: string | null }>();
    if (!row) continue; // gone between the insert and the read: claim it afresh
    if (row.processed_at !== null) return "duplicate";
    if (Date.parse(row.received_at) > now.getTime() - EVENT_LEASE_MS) return "busy";
    const res = await db.prepare(`UPDATE stripe_events SET received_at = ? WHERE id = ? AND processed_at IS NULL AND received_at = ?`).bind(now.toISOString(), eventId, row.received_at).run();
    return (res.meta.changes ?? 0) === 1 ? "claimed" : "busy";
  }
  return "busy";
}

/** The event has been handled: later deliveries of it are duplicates. */
export async function finishEvent(db: D1Database, eventId: string, now: Date = new Date()): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE id = ?`).bind(now.toISOString(), eventId).run();
}

/** Gives up a claim after a failure, so the next delivery can take the event at once instead of waiting out the lease. */
export async function releaseEvent(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET received_at = ? WHERE id = ? AND processed_at IS NULL`).bind(EPOCH, eventId).run();
}
