import type { Env } from "../env";
import { logAgentAction } from "../db/agentActions";
import { TaskFailed, TaskRefused, getTaskKind } from "./registry";

export type ClaudeTaskStatus = "pending" | "claimed" | "done" | "failed" | "expired" | "stale";

/** `kind` is a free string in the table on purpose, so a new kind needs no migration; `registry.ts` is what gives one a meaning. */
export interface ClaudeTask {
  id: string; kind: string; payload: unknown; status: ClaudeTaskStatus; dedupe_key: string | null; attempts: number;
  result: unknown | null; error: string | null; created_at: string; claimed_at: string | null; done_at: string | null;
  target_type: string | null; target_id: string | null;
}

type Row = Omit<ClaudeTask, "payload" | "result"> & { payload: string; result: string | null };
const toTask = (r: Row): ClaudeTask => ({ ...r, payload: JSON.parse(r.payload), result: r.result === null ? null : JSON.parse(r.result) });

/** A claim that is older than this is assumed abandoned (Claude Code closed mid-task) and may be handed out again. */
export const CLAIM_TTL_MS = 30 * 60_000;
/** Claims a task may have in all (the first, plus three reclaims). The reclaim after that fails it instead of handing it out forever. */
export const MAX_ATTEMPTS = 4;
/** Open tasks older than this many days are given up on by `expireOldTasks`. */
export const EXPIRE_AFTER_DAYS = 14;

/** A queue function that can end a task as `failed` takes the whole `env` so the kind's `onFail` hook can run; a bare database still works but runs no hook. */
const dbOf = (t: D1Database | Env): D1Database => ("DB" in t ? t.DB : t);

/** Runs a kind's `onFail` after the task was marked failed. Best effort: a hook that throws is logged and never breaks the claim or completion that failed the task. */
async function runOnFail(target: D1Database | Env, row: Row): Promise<void> {
  if (!("DB" in target)) return;
  const def = getTaskKind(row.kind);
  if (!def?.onFail) return;
  try { await def.onFail(target, JSON.parse(row.payload), row.error ?? "", toTask(row)); }
  catch (e) { console.warn("onFail failed for", row.kind, e); }
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `- ${i.path.join(".") || "value"}: ${i.message}`).join("\n");

/** Thrown by the enqueue functions for a kind nobody registered, or a payload that kind refuses. Nothing is queued. */
export class InvalidTaskError extends Error {}

/**
 * The insert as an unexecuted statement, so a caller can make it part of a `db.batch` (the mail sync enqueues in the same batch that marks a
 * message processed). The payload is validated against the kind's schema first (and stored as the schema parsed it), so a task that Claude could
 * never be briefed on is never queued; that throws `InvalidTaskError` before any statement runs. An open task (pending or claimed) with the same
 * `kind` and `dedupeKey` makes the statement a no-op; a finished one does not. The id is only the new task's: when the statement was a no-op,
 * `enqueueTask` reads the existing one.
 */
export function enqueueTaskStmt(
  db: D1Database, kind: string, payload: unknown, o: { dedupeKey?: string; targetType?: string; targetId?: string } = {},
): { id: string; stmt: D1PreparedStatement } {
  const def = getTaskKind(kind);
  if (!def) throw new InvalidTaskError(`unknown task kind: ${kind}`);
  const parsed = def.payload.safeParse(payload);
  if (!parsed.success) throw new InvalidTaskError(`invalid payload for ${kind}:\n${issues(parsed.error)}`);
  const id = crypto.randomUUID();
  const stmt = db.prepare(
    `INSERT INTO claude_tasks (id, kind, payload, status, dedupe_key, attempts, created_at, target_type, target_id) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`,
  ).bind(id, kind, JSON.stringify(parsed.data), o.dedupeKey ?? null, new Date().toISOString(), o.targetType ?? null, o.targetId ?? null);
  return { id, stmt };
}

/** Queues a task. `created: false` means an open task with the same kind and dedupe key already existed, and `id` is that one. */
export async function enqueueTask(
  db: D1Database, kind: string, payload: unknown, o: { dedupeKey?: string; targetType?: string; targetId?: string } = {},
): Promise<{ id: string; created: boolean }> {
  const { id, stmt } = enqueueTaskStmt(db, kind, payload, o);
  if (((await stmt.run()).meta.changes ?? 0) > 0) return { id, created: true };
  const open = await db.prepare(`SELECT id FROM claude_tasks WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed')`).bind(kind, o.dedupeKey ?? null).first<{ id: string }>();
  // The open one finished between the two statements: the work is not queued any more, so queue it.
  return open ? { id: open.id, created: false } : enqueueTask(db, kind, payload, o);
}

export async function getTask(db: D1Database, id: string): Promise<ClaudeTask | null> {
  const r = await db.prepare(`SELECT * FROM claude_tasks WHERE id = ?`).bind(id).first<Row>();
  return r ? toTask(r) : null;
}

/**
 * Hands out the oldest task that is pending, or claimed so long ago (30 minutes) that its worker is presumed gone. One UPDATE ... RETURNING picks
 * and claims it, so two callers can never get the same task. `attempts` counts claims; a stale task already claimed `MAX_ATTEMPTS` times is
 * not handed out again but failed, so a task that keeps killing its worker cannot cycle forever.
 */
export async function claimNextTask(target: D1Database | Env, now: Date, kinds?: string[]): Promise<ClaudeTask | null> {
  const db = dbOf(target);
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const gaveUp = (await db.prepare(`UPDATE claude_tasks SET status = 'failed', error = ?, done_at = ? WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ? RETURNING *`)
    .bind(`gave up: claimed ${MAX_ATTEMPTS} times and never completed`, now.toISOString(), stale, MAX_ATTEMPTS).all<Row>()).results;
  for (const row of gaveUp) await runOnFail(target, row);
  if (kinds && kinds.length === 0) return null;
  const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  const r = await db.prepare(
    `UPDATE claude_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1, error = NULL
     WHERE id = (SELECT id FROM claude_tasks WHERE (status = 'pending' OR (status = 'claimed' AND claimed_at < ? AND attempts < ?))${kindFilter} ORDER BY created_at, id LIMIT 1)
     RETURNING *`,
  ).bind(now.toISOString(), stale, MAX_ATTEMPTS, ...(kinds ?? [])).first<Row>();
  return r ? toTask(r) : null;
}

/**
 * Ends a claimed task: `done` with its result, or `failed` with an error. True when this call finished it; false when the task was not
 * claimed (never handed out, or already finished), so a task is finished once.
 */
export async function finishClaudeTask(target: D1Database | Env, id: string, status: "done" | "failed", value: unknown): Promise<boolean> {
  const done = status === "done";
  const row = await dbOf(target).prepare(`UPDATE claude_tasks SET status = ?, result = ?, error = ?, done_at = ? WHERE id = ? AND status = 'claimed' RETURNING *`)
    .bind(status, done ? JSON.stringify(value ?? null) : null, done ? null : String(value).slice(0, 1000), new Date().toISOString(), id).first<Row>();
  if (row && !done) await runOnFail(target, row);
  return !!row;
}

/** Closes a claimed task whose target changed or went away: nothing was applied, and the dedupe key is free again. True when this call did it. */
export async function markTaskStale(db: D1Database, id: string, reason: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE claude_tasks SET status = 'stale', error = ?, done_at = ? WHERE id = ? AND status = 'claimed'`)
    .bind(reason.slice(0, 1000), new Date().toISOString(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

export type CompleteResult = { ok: true } | { ok: false; error: string };

/** A pasted JSON string is accepted too: some clients serialize an object argument. */
function asValue(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try { return JSON.parse(result); } catch { return result; }
}

/**
 * Validates Claude's result for a claimed task, applies its effects ONCE and marks the task done.
 *  - A result the kind's schema refuses is returned as an error that lists the zod issues; nothing is applied and the task stays claimed, so
 *    Claude can fix it and try again.
 *  - `apply` runs next. It may refuse (`TaskRefused`: error returned, task stays claimed), give the task up (`TaskFailed`: task failed, error
 *    returned) or report that the target changed (`{ stale }`: task marked stale and the call still succeeds, since there is nothing left for
 *    Claude to do).
 *  - Finishing is a single guarded UPDATE, so a second completion, at the same moment or later, gets `already done`.
 * Nothing here can send, approve or reject anything: that is up to what a kind's `apply` does, and no kind does more than propose.
 */
export async function completeTask(env: Env, id: string, result: unknown): Promise<CompleteResult> {
  const db = env.DB;
  const task = await getTask(db, id);
  if (!task) return { ok: false, error: "task not found" };
  if (task.status === "done") return { ok: false, error: "already done" };
  if (task.status !== "claimed") return { ok: false, error: `task is ${task.status}, not claimed` };
  const def = getTaskKind(task.kind);
  if (!def) return { ok: false, error: `unsupported task kind: ${task.kind}` };

  const parsed = def.result.safeParse(asValue(result));
  if (!parsed.success) return { ok: false, error: `invalid result:\n${issues(parsed.error)}` };
  const payload = def.payload.safeParse(task.payload);
  if (!payload.success) {
    const error = `the task payload is not a ${task.kind} task`;
    await finishClaudeTask(env, task.id, "failed", error);
    return { ok: false, error };
  }

  // The lease: refresh `claimed_at`, but only if it is still what we read. Two sessions can both hold a claim (one stalled past 30 minutes, the other
  // reclaimed it), so exactly one of them gets to run `apply`; the other is told so. The refresh also keeps the task from being reclaimed while `apply` runs.
  const leaseAt = new Date(Math.max(Date.now(), Date.parse(task.claimed_at ?? "") + 1 || 0)).toISOString();
  const leased = await db.prepare(`UPDATE claude_tasks SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claimed_at IS ?`).bind(leaseAt, task.id, task.claimed_at).run();
  if ((leased.meta.changes ?? 0) === 0) {
    const now = await getTask(db, id);
    return { ok: false, error: now?.status === "done" ? "already done" : "already being completed by another session" };
  }

  let outcome: Awaited<ReturnType<typeof def.apply>>;
  try {
    outcome = await def.apply(env, payload.data, parsed.data, task);
  } catch (e) {
    if (e instanceof TaskRefused) return { ok: false, error: e.message };
    if (e instanceof TaskFailed) { await finishClaudeTask(env, task.id, "failed", e.message); return { ok: false, error: e.message }; }
    throw e;
  }
  if (outcome && "stale" in outcome) {
    await markTaskStale(db, task.id, outcome.stale);
    await logAgentAction(db, { actor: "mcp", tool: "complete_claude_task", summary: `${task.kind} task ${task.id} is stale: ${outcome.stale}` });
    return { ok: true };
  }

  if (!(await finishClaudeTask(db, task.id, "done", parsed.data))) return { ok: false, error: "already done" }; // another completion got there first
  const log = outcome?.log;
  await logAgentAction(db, {
    actor: "mcp", tool: "complete_claude_task", summary: log?.summary ?? `completed ${task.kind} task ${task.id}`,
    ...(log?.recordType && log.recordId ? { record_type: log.recordType, record_id: log.recordId } : {}),
  });
  return { ok: true };
}

/**
 * Hands a claimed task back, for a worker that cannot do it (`reason` is kept on the task). It goes back to pending for the next claim. A task
 * that has already used all its claims fails instead, so a task nobody can do does not go round forever. False when the task is not claimed.
 */
export async function releaseTask(target: D1Database | Env, id: string, reason: string): Promise<boolean> {
  const db = dbOf(target);
  const t = await getTask(db, id);
  if (!t || t.status !== "claimed") return false;
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (t.attempts >= MAX_ATTEMPTS) {
    const row = await db.prepare(`UPDATE claude_tasks SET status = 'failed', error = ?, done_at = ? WHERE id = ? AND status = 'claimed' RETURNING *`)
      .bind(`gave up: released after ${t.attempts} claims (${why})`, new Date().toISOString(), id).first<Row>();
    if (row) await runOnFail(target, row);
    return !!row;
  }
  const r = await db.prepare(`UPDATE claude_tasks SET status = 'pending', claimed_at = NULL, error = ? WHERE id = ? AND status = 'claimed'`).bind(`released: ${why}`, id).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Gives up on work nobody picked up: open tasks (pending, or claimed and never finished) created more than `maxAgeDays` ago become `expired`, and
 * each kind's `onExpire` hook runs for its tasks (a failing hook is logged and does not stop the rest). Takes the whole `env` because a hook may
 * need more than the database. Returns how many tasks expired.
 */
export async function expireOldTasks(env: Env, now: Date, maxAgeDays: number = EXPIRE_AFTER_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const expired = (await env.DB.prepare(
    `UPDATE claude_tasks SET status = 'expired', error = ?, done_at = ? WHERE status IN ('pending','claimed') AND created_at < ? RETURNING kind, payload`,
  ).bind(`expired: nobody finished it within ${maxAgeDays} days`, now.toISOString(), cutoff).all<{ kind: string; payload: string }>()).results;
  for (const t of expired) {
    const def = getTaskKind(t.kind);
    if (!def?.onExpire) continue;
    try { await def.onExpire(env, JSON.parse(t.payload)); }
    catch (e) { console.error("onExpire failed for", t.kind, e); }
  }
  return expired.length;
}

/** Closes the open tasks about one target (its lead was deleted, say) so nobody works on them. They end `stale`. Returns how many. */
export async function cancelTasksFor(db: D1Database, targetType: string, targetId: string): Promise<number> {
  const r = await db.prepare(
    `UPDATE claude_tasks SET status = 'stale', error = 'cancelled: its target is gone', done_at = ? WHERE target_type = ? AND target_id = ? AND status IN ('pending','claimed')`,
  ).bind(new Date().toISOString(), targetType, targetId).run();
  return r.meta.changes ?? 0;
}

/** Open work per kind, for the status line and the queue tool. Kinds with nothing open are left out. */
export async function queueCounts(db: D1Database): Promise<Record<string, { pending: number; claimed: number }>> {
  const rows = (await db.prepare(
    `SELECT kind, status, COUNT(*) AS n FROM claude_tasks WHERE status IN ('pending','claimed') GROUP BY kind, status`,
  ).all<{ kind: string; status: "pending" | "claimed"; n: number }>()).results;
  const out: Record<string, { pending: number; claimed: number }> = {};
  for (const r of rows) (out[r.kind] ??= { pending: 0, claimed: 0 })[r.status] = r.n;
  return out;
}
