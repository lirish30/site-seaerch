import type { Contact, ContactInput } from "../types";
import { chunks } from "./chunks";

export async function replaceContacts(db: D1Database, businessId: string, list: ContactInput[]): Promise<Contact[]> {
  const stmts = [db.prepare(`DELETE FROM contacts WHERE business_id = ?`).bind(businessId)];
  for (const c of list) {
    stmts.push(db.prepare(
      `INSERT INTO contacts (id, business_id, type, value, source_url, person_name, role, confidence)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), businessId, c.type, c.value, c.source_url, c.person_name, c.role, c.confidence));
  }
  await db.batch(stmts);
  return listContacts(db, businessId);
}

export async function listContacts(db: D1Database, businessId: string): Promise<Contact[]> {
  return (await db.prepare(`SELECT * FROM contacts WHERE business_id = ?`).bind(businessId).all<Contact>()).results;
}

/** Contacts for many businesses, one query per chunk of ids, grouped by business. */
export async function contactsFor(db: D1Database, businessIds: string[]): Promise<Map<string, Contact[]>> {
  const out = new Map<string, Contact[]>();
  for (const ids of chunks([...new Set(businessIds)])) {
    const rows = (await db.prepare(`SELECT * FROM contacts WHERE business_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<Contact>()).results;
    for (const c of rows) out.set(c.business_id, [...(out.get(c.business_id) ?? []), c]);
  }
  return out;
}
