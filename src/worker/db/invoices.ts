export type InvoiceStatus = "open" | "paid" | "void" | "uncollectible" | "failed";

export interface InvoiceRow {
  id: string; businessId: string; dealId: string; documentId: string; kind: "deposit"; stripeCustomerId: string; stripeInvoiceId: string;
  /** Integer cents. */
  amountCents: number; status: InvoiceStatus; hostedUrl: string; mismatch: string | null; createdAt: string; paidAt: string | null;
}

interface Row {
  id: string; business_id: string; deal_id: string; document_id: string; kind: "deposit"; stripe_customer_id: string; stripe_invoice_id: string;
  amount_cents: number; status: InvoiceStatus; hosted_url: string; mismatch: string | null; created_at: string; paid_at: string | null;
}

const toInvoice = (r: Row): InvoiceRow => ({
  id: r.id, businessId: r.business_id, dealId: r.deal_id, documentId: r.document_id, kind: r.kind, stripeCustomerId: r.stripe_customer_id,
  stripeInvoiceId: r.stripe_invoice_id, amountCents: r.amount_cents, status: r.status, hostedUrl: r.hosted_url, mismatch: r.mismatch, createdAt: r.created_at, paidAt: r.paid_at,
});

export async function getInvoiceForDocument(db: D1Database, documentId: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE document_id = ? AND kind = 'deposit'`).bind(documentId).first<Row>();
  return r ? toInvoice(r) : null;
}

export async function getInvoiceByStripeId(db: D1Database, stripeInvoiceId: string): Promise<InvoiceRow | null> {
  const r = await db.prepare(`SELECT * FROM invoices WHERE stripe_invoice_id = ?`).bind(stripeInvoiceId).first<Row>();
  return r ? toInvoice(r) : null;
}

/** A new deposit invoice, open. A document has one: a second insert for it, or a reused Stripe invoice id, throws (the unique indexes). */
export async function insertInvoice(db: D1Database, o: Omit<InvoiceRow, "id" | "createdAt" | "paidAt" | "mismatch" | "status">): Promise<InvoiceRow> {
  if (!Number.isSafeInteger(o.amountCents) || o.amountCents <= 0) throw new RangeError("an invoice is for a whole, positive number of cents");
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO invoices (id, business_id, deal_id, document_id, kind, stripe_customer_id, stripe_invoice_id, amount_cents, status, hosted_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).bind(id, o.businessId, o.dealId, o.documentId, o.kind, o.stripeCustomerId, o.stripeInvoiceId, o.amountCents, o.hostedUrl, new Date().toISOString()).run();
  return (await getInvoiceByStripeId(db, o.stripeInvoiceId))!;
}

export interface InvoicePatch { status?: InvoiceStatus; mismatch?: string | null; paidAt?: string | null; hostedUrl?: string }

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
