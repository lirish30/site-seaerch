import type { Person, PersonInput } from "../types";

type Row = Omit<Person, "is_poc"> & { is_poc: number };
const fromRow = (r: Row): Person => ({ ...r, is_poc: r.is_poc === 1 });

export async function listPeople(db: D1Database, businessId: string): Promise<Person[]> {
  return (await db.prepare(`SELECT * FROM people WHERE business_id = ? ORDER BY is_poc DESC, created_at`).bind(businessId).all<Row>()).results.map(fromRow);
}

export async function getPerson(db: D1Database, businessId: string, id: string): Promise<Person | null> {
  const r = await db.prepare(`SELECT * FROM people WHERE id = ? AND business_id = ?`).bind(id, businessId).first<Row>();
  return r ? fromRow(r) : null;
}

/** Only one point of contact per lead: setting one clears the others. */
async function clearPoc(db: D1Database, businessId: string) {
  await db.prepare(`UPDATE people SET is_poc = 0 WHERE business_id = ?`).bind(businessId).run();
}

export async function createPerson(db: D1Database, businessId: string, p: PersonInput): Promise<Person> {
  const id = crypto.randomUUID();
  if (p.is_poc) await clearPoc(db, businessId);
  await db.prepare(
    `INSERT INTO people (id, business_id, name, role, email, phone, linkedin, source, is_poc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, businessId, p.name, p.role ?? null, p.email ?? null, p.phone ?? null, p.linkedin ?? null, p.source ?? "manual",
    p.is_poc ? 1 : 0, new Date().toISOString()).run();
  return (await getPerson(db, businessId, id))!;
}

export async function updatePerson(db: D1Database, businessId: string, id: string, p: Partial<PersonInput>): Promise<Person | null> {
  if (!(await getPerson(db, businessId, id))) return null;
  if (p.is_poc) await clearPoc(db, businessId);
  const cols: [string, unknown][] = [];
  for (const k of ["name", "role", "email", "phone", "linkedin"] as const) if (p[k] !== undefined) cols.push([k, p[k]]);
  if (p.is_poc !== undefined) cols.push(["is_poc", p.is_poc ? 1 : 0]);
  if (cols.length) {
    await db.prepare(`UPDATE people SET ${cols.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND business_id = ?`)
      .bind(...cols.map(([, v]) => v), id, businessId).run();
  }
  return getPerson(db, businessId, id);
}

export async function deletePerson(db: D1Database, businessId: string, id: string): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM people WHERE id = ? AND business_id = ?`).bind(id, businessId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function pocFor(db: D1Database, businessId: string): Promise<Person | null> {
  const r = await db.prepare(`SELECT * FROM people WHERE business_id = ? AND is_poc = 1 LIMIT 1`).bind(businessId).first<Row>();
  return r ? fromRow(r) : null;
}
