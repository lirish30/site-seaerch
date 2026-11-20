/** A hold stops Logan's and Claude's tasks for a business whose invoice went unpaid. The client's work, hosting and monitoring are never touched by it. */
export interface Hold {
  id: string; businessId: string; invoiceId: string; placedAt: string; liftedAt: string | null; liftedBy: "payment" | "void" | "manual" | null;
}

interface Row { id: string; business_id: string; invoice_id: string; placed_at: string; lifted_at: string | null; lifted_by: Hold["liftedBy"] }
const toHold = (r: Row): Hold => ({ id: r.id, businessId: r.business_id, invoiceId: r.invoice_id, placedAt: r.placed_at, liftedAt: r.lifted_at, liftedBy: r.lifted_by });

/** Places the hold for an invoice. An invoice has at most one, ever (a lifted one is not placed again). True only when this call made it. */
export async function placeHold(db: D1Database, o: { businessId: string; invoiceId: string; now: string }): Promise<boolean> {
  const res = await db.prepare(`INSERT INTO billing_holds (id, business_id, invoice_id, placed_at) VALUES (?, ?, ?, ?) ON CONFLICT (invoice_id) DO NOTHING`)
    .bind(crypto.randomUUID(), o.businessId, o.invoiceId, o.now).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Lifts the open hold of an invoice that was paid or voided. Returns how many it lifted (0 or 1). */
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

export async function isOnHold(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM billing_holds WHERE business_id = ? AND lifted_at IS NULL LIMIT 1`).bind(businessId).first());
}

/** A SQL condition for a query whose row (named `alias`) has a business_id: true when that business has no open hold. */
export const holdFreeSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM billing_holds h WHERE h.business_id = ${alias}.business_id AND h.lifted_at IS NULL)`;
