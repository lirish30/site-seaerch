export type ClaudeTaskStatus = "pending" | "claimed" | "done" | "failed" | "expired";

/** `kind` is a free string on purpose: the queue knows nothing about what a kind means, so new kinds need no change here. */
export interface ClaudeTask {
  id: string; kind: string; payload: unknown; status: ClaudeTaskStatus; dedupe_key: string | null; attempts: number;
  result: unknown | null; error: string | null; created_at: string; claimed_at: string | null; done_at: string | null;
}

type Row = Omit<ClaudeTask, "payload" | "result"> & { payload: string; result: string | null };
const toTask = (r: Row): ClaudeTask => ({ ...r, payload: JSON.parse(r.payload), result: r.result === null ? null : JSON.parse(r.result) });

/** A claim that is older than this is assumed abandoned (Claude Code closed mid-task) and may be handed out again. */
export const CLAIM_TTL_MS = 30 * 60_000;
/** Claims a task may have in all (the first, plus three reclaims). The reclaim after that fails it instead of handing it out forever. */
export const MAX_ATTEMPTS = 4;

/**
 * The insert as an unexecuted statement, so a caller can make it part of a `db.batch` (the mail sync enqueues in the same batch that marks
 * a message processed). An open task (pending or claimed) with the same `kind` and `dedupeKey` makes it a no-op; a finished one does not.
 * The id is only the new task's: when the statement was a no-op, `enqueueClaudeTask` reads the existing one.
 */
export function enqueueClaudeTaskStmt(db: D1Database, kind: string, payload: unknown, o: { dedupeKey?: string } = {}): { id: string; stmt: D1PreparedStatement } {
  const id = crypto.randomUUID();
  const stmt = db.prepare(
    `INSERT INTO claude_tasks (id, kind, payload, status, dedupe_key, attempts, created_at) VALUES (?, ?, ?, 'pending', ?, 0, ?)
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`,
  ).bind(id, kind, JSON.stringify(payload), o.dedupeKey ?? null, new Date().toISOString());
  return { id, stmt };
}

/** Queues a task. `created: false` means an open task with the same kind and dedupe key already existed, and `id` is that one. */
export async function enqueueClaudeTask(db: D1Database, kind: string, payload: unknown, o: { dedupeKey?: string } = {}): Promise<{ id: string; created: boolean }> {
  const { id, stmt } = enqueueClaudeTaskStmt(db, kind, payload, o);
  if (((await stmt.run()).meta.changes ?? 0) > 0) return { id, created: true };
  const open = await db.prepare(`SELECT id FROM claude_tasks WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed')`).bind(kind, o.dedupeKey ?? null).first<{ id: string }>();
  // The open one finished between the two statements: the work is not queued any more, so queue it.
  return open ? { id: open.id, created: false } : enqueueClaudeTask(db, kind, payload, o);
}

export async function getClaudeTask(db: D1Database, id: string): Promise<ClaudeTask | null> {
  const r = await db.prepare(`SELECT * FROM claude_tasks WHERE id = ?`).bind(id).first<Row>();
  return r ? toTask(r) : null;
}

/**
 * Hands out the oldest task that is pending, or claimed so long ago (30 minutes) that its worker is presumed gone. One UPDATE ... RETURNING picks
 * and claims it, so two callers can never get the same task. `attempts` counts claims; a stale task already claimed `MAX_ATTEMPTS` times is
 * not handed out again but failed, so a task that keeps killing its worker cannot cycle forever.
 */
export async function claimNextClaudeTask(db: D1Database, now: Date, kinds?: string[]): Promise<ClaudeTask | null> {
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  await db.prepare(`UPDATE claude_tasks SET status = 'failed', error = ?, done_at = ? WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ?`)
    .bind(`gave up: claimed ${MAX_ATTEMPTS} times and never completed`, now.toISOString(), stale, MAX_ATTEMPTS).run();
  if (kinds && kinds.length === 0) return null;
  const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  const r = await db.prepare(
    `UPDATE claude_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
     WHERE id = (SELECT id FROM claude_tasks WHERE (status = 'pending' OR (status = 'claimed' AND claimed_at < ? AND attempts < ?))${kindFilter} ORDER BY created_at, id LIMIT 1)
     RETURNING *`,
  ).bind(now.toISOString(), stale, MAX_ATTEMPTS, ...(kinds ?? [])).first<Row>();
  return r ? toTask(r) : null;
}

/**
 * Ends a claimed task: `done` with its result, or `failed` with an error. True when this call finished it; false when the task was not
 * claimed (never handed out, or already finished), so a task is finished once.
 */
export async function finishClaudeTask(db: D1Database, id: string, status: "done" | "failed", value: unknown): Promise<boolean> {
  const done = status === "done";
  const r = await db.prepare(`UPDATE claude_tasks SET status = ?, result = ?, error = ?, done_at = ? WHERE id = ? AND status = 'claimed'`)
    .bind(status, done ? JSON.stringify(value ?? null) : null, done ? null : String(value).slice(0, 1000), new Date().toISOString(), id).run();
  return (r.meta.changes ?? 0) > 0;
}
