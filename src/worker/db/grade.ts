// A client's grade (Plan 15): A, B or C with a note, kept on the business row. No grade is null; the set time goes with it.
// Times (`now`) are UTC ISO strings with milliseconds.

export type Grade = "A" | "B" | "C";
export interface GradeInfo { grade: Grade | null; note: string; setAt: string | null }

interface GradeRow { id: string; client_grade: Grade | null; client_grade_note: string; client_grade_set_at: string | null }

/** The grade, note and set time of each business given; a business with no grade reads as `{ grade: null, note: "", setAt: null }`, and an id that is no business is left out. */
export async function getGrades(db: D1Database, ids: string[]): Promise<Map<string, GradeInfo>> {
  const out = new Map<string, GradeInfo>();
  // One statement per 50 ids keeps clear of the bound-parameter limit.
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT id, client_grade, client_grade_note, client_grade_set_at FROM businesses WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<GradeRow>()).results;
    for (const r of rows) out.set(r.id, { grade: r.client_grade, note: r.client_grade_note, setAt: r.client_grade_set_at });
  }
  return out;
}

/** Grades the business, or clears the grade (null), in one statement. Clearing also clears the note and the set time; a grade stamps the set time `now`. */
export async function setGrade(db: D1Database, businessId: string, grade: Grade | null, note: string, now: string): Promise<void> {
  if (grade === null) {
    await db.prepare(`UPDATE businesses SET client_grade = NULL, client_grade_note = '', client_grade_set_at = NULL WHERE id = ?`).bind(businessId).run();
    return;
  }
  await db.prepare(`UPDATE businesses SET client_grade = ?, client_grade_note = ?, client_grade_set_at = ? WHERE id = ?`).bind(grade, note, now, businessId).run();
}
