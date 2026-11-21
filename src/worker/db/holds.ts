/** A hold stops Logan's and Claude's tasks for a business whose invoice went unpaid. The client's work, hosting and monitoring are never touched by it. */
export interface Hold {
  id: string; businessId: string; invoiceId: string; placedAt: string; liftedAt: string | null; liftedBy: "payment" | "void" | "manual" | null;
}

interface Row { id: string; business_id: string; invoice_id: string; placed_at: string; lifted_at: string | null; lifted_by: Hold["liftedBy"] }
const toHold = (r: Row): Hold => ({ id: r.id, businessId: r.business_id, invoiceId: r.invoice_id, placedAt: r.placed_at, liftedAt: r.lifted_at, liftedBy: r.lifted_by });

/**
 * Places the hold for an invoice. An invoice has at most one, ever (a lifted one is not placed again), and only an invoice that is still `open` or `failed` can be held: checked in the statement
 * itself, so a payment or a void that lands after the caller read its list is never followed by a hold that nothing would lift. True only when this call made it.
 */
export async function placeHold(db: D1Database, o: { businessId: string; invoiceId: string; now: string }): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO billing_holds (id, business_id, invoice_id, placed_at)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status IN ('open', 'failed'))
     ON CONFLICT (invoice_id) DO NOTHING`,
  ).bind(crypto.randomUUID(), o.businessId, o.invoiceId, o.now, o.invoiceId).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Lifts the open hold of an invoice that was paid, voided or written off (a write-off counts as `void`: nothing more is owed on it that holds work back). Returns how many it lifted (0 or 1). */
export async function liftHoldsForInvoice(db: D1Database, invoiceId: string, by: "payment" | "void", now: string): Promise<number> {
  const res = await db.prepare(`UPDATE billing_holds SET lifted_at = ?, lifted_by = ? WHERE invoice_id = ? AND lifted_at IS NULL`).bind(now, by, invoiceId).run();
  return res.meta.changes ?? 0;
}

/** Lifts one hold by hand. False when it is already lifted or does not exist. */
export async function liftHold(db: D1Database, id: string, by: "manual", now: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE billing_holds SET lifted_at = ?, lifted_by = ? WHERE id = ? AND lifted_at IS NULL`).bind(now, by, id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Open holds, oldest first, with the business name (for one business, or all). */
export async function activeHolds(db: D1Database, businessId?: string): Promise<(Hold & { businessName: string })[]> {
  const where = businessId === undefined ? "" : " AND h.business_id = ?";
  const rows = (await db.prepare(
    `SELECT h.*, b.name AS business_name FROM billing_holds h JOIN businesses b ON b.id = h.business_id WHERE h.lifted_at IS NULL${where} ORDER BY h.placed_at, h.id`,
  ).bind(...(businessId === undefined ? [] : [businessId])).all<Row & { business_name: string }>()).results;
  return rows.map((r) => ({ ...toHold(r), businessName: r.business_name }));
}

/** One hold by id, lifted or not, or null. */
export async function getHold(db: D1Database, id: string): Promise<Hold | null> {
  const r = await db.prepare(`SELECT * FROM billing_holds WHERE id = ?`).bind(id).first<Row>();
  return r ? toHold(r) : null;
}

/** The hold an invoice has, lifted or not (at most one, ever), or null. */
export async function holdForInvoice(db: D1Database, invoiceId: string): Promise<Hold | null> {
  const r = await db.prepare(`SELECT * FROM billing_holds WHERE invoice_id = ?`).bind(invoiceId).first<Row>();
  return r ? toHold(r) : null;
}

export async function isOnHold(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM billing_holds WHERE business_id = ? AND lifted_at IS NULL LIMIT 1`).bind(businessId).first());
}

/** The ids among `businessIds` that have an open hold: `isOnHold` for many businesses at once. The caller keeps the list short (one chunk). */
export async function heldBusinessIds(db: D1Database, businessIds: string[]): Promise<Set<string>> {
  if (businessIds.length === 0) return new Set();
  const rows = (await db.prepare(`SELECT DISTINCT business_id FROM billing_holds WHERE lifted_at IS NULL AND business_id IN (${businessIds.map(() => "?").join(",")})`)
    .bind(...businessIds).all<{ business_id: string }>()).results;
  return new Set(rows.map((r) => r.business_id));
}

/** A SQL condition for a query whose row (named `alias`) has a business_id: true when that business has no open hold. */
export const holdFreeSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM billing_holds h WHERE h.business_id = ${alias}.business_id AND h.lifted_at IS NULL)`;
