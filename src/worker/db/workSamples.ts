import type { WorkSample } from "../types";

export type WorkSampleInput = Pick<WorkSample, "title" | "url" | "result_line" | "tags">;

export async function listWorkSamples(db: D1Database): Promise<WorkSample[]> {
  return (await db.prepare(`SELECT * FROM work_samples ORDER BY created_at ASC, id ASC`).all<WorkSample>()).results;
}

export async function createWorkSample(db: D1Database, s: WorkSampleInput): Promise<WorkSample> {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO work_samples (id, title, url, result_line, tags, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, s.title, s.url, s.result_line, s.tags, new Date().toISOString()).run();
  return (await db.prepare(`SELECT * FROM work_samples WHERE id = ?`).bind(id).first<WorkSample>())!;
}

export async function updateWorkSample(db: D1Database, id: string, s: Partial<WorkSampleInput>): Promise<WorkSample | null> {
  const keys = (["title", "url", "result_line", "tags"] as const).filter((k) => s[k] !== undefined);
  if (keys.length) await db.prepare(`UPDATE work_samples SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => s[k]), id).run();
  return db.prepare(`SELECT * FROM work_samples WHERE id = ?`).bind(id).first<WorkSample>();
}

export async function deleteWorkSample(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(`DELETE FROM work_samples WHERE id = ?`).bind(id).run()).meta.changes ?? 0) > 0;
}
