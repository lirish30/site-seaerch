import type { Env } from "../env";
import { logAgentAction } from "../db/agentActions";
import { HelperRefused, getHelperKind } from "./kinds";

export type HelperJobStatus = "pending" | "claimed" | "done" | "failed" | "expired";

/** `kind` is a free string in the table on purpose, so a new kind needs no migration; `kinds.ts` is what gives one a meaning. */
export interface HelperJob {
  id: string; kind: string; video_id: string | null; payload: unknown; status: HelperJobStatus; dedupe_key: string | null; attempts: number;
  claimed_at: string | null; claimed_by: string | null; result: unknown | null; error: string | null; created_at: string; done_at: string | null;
}
type Row = Omit<HelperJob, "payload" | "result"> & { payload: string; result: string | null };
const toJob = (r: Row): HelperJob => ({ ...r, payload: JSON.parse(r.payload), result: r.result === null ? null : JSON.parse(r.result) });

/** A claim older than this is assumed abandoned (the Mac slept, the helper died) and may be handed out again. */
export const CLAIM_TTL_MS = 20 * 60_000;
/** Claims a job may have in all (the first, plus three reclaims). The reclaim after that fails it instead of handing it out forever. */
export const MAX_ATTEMPTS = 4;
/** Open jobs older than this many days are given up on by `expireOldHelperJobs`. */
export const EXPIRE_AFTER_DAYS = 14;
/** The helper counts as online when a device was seen this recently. */
export const ONLINE_WITHIN_MS = 3 * 60_000;

/** A function that can end a job as `failed` or `expired` takes the whole `env` so the kind's hook can run; a bare database still works but runs no hook. */
const dbOf = (t: D1Database | Env): D1Database => ("DB" in t ? t.DB : t);

/** Thrown for a kind nobody registered or a payload that kind refuses. Nothing is queued. */
export class InvalidHelperJobError extends Error {}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `- ${i.path.join(".") || "value"}: ${i.message}`).join("\n");

/** Runs a kind's `onFail` after the job was marked failed. Best effort: a hook that throws is logged and never breaks the claim or completion that failed the job. */
async function runOnFail(target: D1Database | Env, row: Row): Promise<void> {
  if (!("DB" in target)) return;
  const hook = getHelperKind(row.kind)?.onFail;
  if (!hook) return;
  try { await hook(target, JSON.parse(row.payload), row.error ?? ""); }
  catch (e) { console.warn("helper onFail failed for", row.kind, e); }
}

/**
 * Queues a job for the Mac helper. The payload is validated against the kind's schema first and stored as the schema parsed it. An open job
 * (pending or claimed) with the same `kind` and `dedupeKey` makes this a no-op: `created: false` and `id` is the existing one. A finished one does not.
 */
export async function enqueueHelperJob(
  db: D1Database, kind: string, payload: unknown, o: { videoId?: string; dedupeKey?: string } = {},
): Promise<{ id: string; created: boolean }> {
  const def = getHelperKind(kind);
  if (!def) throw new InvalidHelperJobError(`unknown helper kind: ${kind}`);
  const parsed = def.payload.safeParse(payload);
  if (!parsed.success) throw new InvalidHelperJobError(`invalid payload for ${kind}:\n${issues(parsed.error)}`);
  const id = crypto.randomUUID();
  const r = await db.prepare(
    `INSERT INTO helper_jobs (id, kind, video_id, payload, status, dedupe_key, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`,
  ).bind(id, kind, o.videoId ?? null, JSON.stringify(parsed.data), o.dedupeKey ?? null, new Date().toISOString()).run();
  if ((r.meta.changes ?? 0) > 0) return { id, created: true };
  const open = await db.prepare(`SELECT id FROM helper_jobs WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed')`).bind(kind, o.dedupeKey ?? null).first<{ id: string }>();
  // The open one finished between the two statements: the work is not queued any more, so queue it.
  return open ? { id: open.id, created: false } : enqueueHelperJob(db, kind, payload, o);
}

export async function getHelperJob(db: D1Database, id: string): Promise<HelperJob | null> {
  const r = await db.prepare(`SELECT * FROM helper_jobs WHERE id = ?`).bind(id).first<Row>();
  return r ? toJob(r) : null;
}

/** A video's jobs, oldest first: what its editor shows while the Mac works. */
export async function helperJobsForVideo(db: D1Database, videoId: string): Promise<Pick<HelperJob, "id" | "kind" | "status" | "error">[]> {
  return (await db.prepare(`SELECT id, kind, status, error FROM helper_jobs WHERE video_id = ? ORDER BY created_at, id`).bind(videoId).all<Pick<HelperJob, "id" | "kind" | "status" | "error">>()).results;
}

/**
 * Hands out the oldest job that is pending, or claimed so long ago (20 minutes) that its device is presumed gone, to `deviceId`. One UPDATE ... RETURNING
 * picks and claims it, so two devices can never get the same job. `attempts` counts claims; a stale job already claimed `MAX_ATTEMPTS` times is not
 * handed out again but failed, so a job that keeps killing its worker cannot cycle forever. `kinds` limits what is handed out (an empty list hands out nothing).
 */
export async function claimHelperJob(target: D1Database | Env, deviceId: string, now: Date, kinds?: string[]): Promise<HelperJob | null> {
  const db = dbOf(target);
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const gaveUp = (await db.prepare(`UPDATE helper_jobs SET status = 'failed', error = ?, done_at = ? WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ? RETURNING *`)
    .bind(`gave up: claimed ${MAX_ATTEMPTS} times and never completed`, now.toISOString(), stale, MAX_ATTEMPTS).all<Row>()).results;
  for (const row of gaveUp) await runOnFail(target, row);
  if (kinds && kinds.length === 0) return null;
  const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  const r = await db.prepare(
    `UPDATE helper_jobs SET status = 'claimed', claimed_at = ?, claimed_by = ?, attempts = attempts + 1, error = NULL
     WHERE id = (SELECT id FROM helper_jobs WHERE (status = 'pending' OR (status = 'claimed' AND claimed_at < ? AND attempts < ?))${kindFilter} ORDER BY created_at, id LIMIT 1)
     RETURNING *`,
  ).bind(now.toISOString(), deviceId, stale, MAX_ATTEMPTS, ...(kinds ?? [])).first<Row>();
  if (!r) return null;
  await logAgentAction(db, {
    actor: "helper", tool: "helper.claim", summary: `claimed ${r.kind} job ${r.id}${r.attempts > 1 ? ` (claim ${r.attempts})` : ""}`,
    ...(r.video_id ? { record_type: "video", record_id: r.video_id } : {}),
  });
  return toJob(r);
}

export type CompleteResult = { ok: true } | { ok: false; error: string };
export const NOT_YOURS = "this job is not claimed by this device";
export const NOT_FOUND = "job not found";
export const ALREADY_DONE = "already done";

/**
 * Validates the helper's result for a job `deviceId` holds, applies its effects ONCE and marks the job done.
 *  - A device that does not hold the claim is refused (`NOT_YOURS`); a job that is already done says `already done`.
 *  - A result the kind's schema refuses is returned as an error that lists the issues; nothing is applied and the job stays claimed.
 *  - `apply` runs under a lease: `claimed_at` is refreshed, but only if it is still what we read, so two completions at the same moment (or a
 *    stalled device and the one that reclaimed the job) never both run `apply`. The refresh also keeps the job from being reclaimed while `apply` runs.
 *    `HelperRefused` from `apply` is returned as the error and the job stays claimed.
 *  - Finishing is a single guarded UPDATE.
 */
export async function completeHelperJob(env: Env, id: string, deviceId: string, result: unknown): Promise<CompleteResult> {
  const db = env.DB;
  const job = await getHelperJob(db, id);
  if (!job) return { ok: false, error: NOT_FOUND };
  if (job.status === "done") return { ok: false, error: ALREADY_DONE };
  if (job.status !== "claimed") return { ok: false, error: `job is ${job.status}, not claimed` };
  if (job.claimed_by !== deviceId) return { ok: false, error: NOT_YOURS };
  const def = getHelperKind(job.kind);
  if (!def) return { ok: false, error: `unsupported job kind: ${job.kind}` };

  const parsed = def.result.safeParse(result);
  if (!parsed.success) return { ok: false, error: `invalid result:\n${issues(parsed.error)}` };
  const payload = def.payload.safeParse(job.payload);
  if (!payload.success) {
    const error = `the job payload is not a ${job.kind} job`;
    await failHelperJob(env, id, deviceId, error);
    return { ok: false, error };
  }

  const leaseAt = new Date(Math.max(Date.now(), Date.parse(job.claimed_at ?? "") + 1 || 0)).toISOString();
  const leased = await db.prepare(`UPDATE helper_jobs SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND claimed_at IS ?`).bind(leaseAt, id, deviceId, job.claimed_at).run();
  if ((leased.meta.changes ?? 0) === 0) {
    const now = await getHelperJob(db, id);
    return { ok: false, error: now?.status === "done" ? ALREADY_DONE : now?.claimed_by !== deviceId ? NOT_YOURS : "already being completed by another request" };
  }

  try {
    await def.apply(env, payload.data, parsed.data);
  } catch (e) {
    if (e instanceof HelperRefused) return { ok: false, error: e.message };
    throw e;
  }

  const done = await db.prepare(`UPDATE helper_jobs SET status = 'done', result = ?, error = NULL, done_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`)
    .bind(JSON.stringify(parsed.data), new Date().toISOString(), id, deviceId).run();
  if ((done.meta.changes ?? 0) === 0) return { ok: false, error: ALREADY_DONE };
  await logAgentAction(db, {
    actor: "helper", tool: "helper.complete", summary: `completed ${job.kind} job ${id}`,
    ...(job.video_id ? { record_type: "video", record_id: job.video_id } : {}),
  });
  return { ok: true };
}

/** The helper gives a job up: it ends `failed` with the reason and the kind's `onFail` hook runs. False when `deviceId` does not hold the claim. */
export async function failHelperJob(target: D1Database | Env, id: string, deviceId: string, error: string): Promise<boolean> {
  const row = await dbOf(target).prepare(`UPDATE helper_jobs SET status = 'failed', error = ?, done_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ? RETURNING *`)
    .bind(error.replace(/\s+/g, " ").trim().slice(0, 1000) || "the helper gave no reason", new Date().toISOString(), id, deviceId).first<Row>();
  if (row) await runOnFail(target, row);
  return !!row;
}

/**
 * The helper says it is still working: `claimed_at` becomes `now`, but only while the job is `claimed` by `deviceId`, so a long job (a care update) is not handed to a second Mac.
 * False when the job is not this device's any more (done, failed, expired, or reclaimed by another).
 */
export async function touchHelperJob(db: D1Database, id: string, deviceId: string, now: Date): Promise<boolean> {
  const r = await db.prepare(`UPDATE helper_jobs SET claimed_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`).bind(now.toISOString(), id, deviceId).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Closes the open jobs of one video (it was cancelled or failed) so no Mac time is spent on them. They end `expired`. Returns how many. */
export async function cancelHelperJobsFor(db: D1Database, videoId: string): Promise<number> {
  const r = await db.prepare(`UPDATE helper_jobs SET status = 'expired', error = 'cancelled: its video is finished with', done_at = ? WHERE video_id = ? AND status IN ('pending','claimed')`)
    .bind(new Date().toISOString(), videoId).run();
  return r.meta.changes ?? 0;
}

/** Closes every open job of one kind (a newer piece of work replaced it): they end `expired` with `why`. Returns how many. */
export async function cancelOpenHelperJobsOfKind(db: D1Database, kind: string, why: string): Promise<number> {
  const r = await db.prepare(`UPDATE helper_jobs SET status = 'expired', error = ?, done_at = ? WHERE kind = ? AND status IN ('pending','claimed')`)
    .bind(`cancelled: ${why}`, new Date().toISOString(), kind).run();
  return r.meta.changes ?? 0;
}

/**
 * Gives up on work nobody did: open jobs (pending, or claimed and never finished) created more than `maxAgeDays` ago become `expired`, and each
 * kind's `onExpire` hook runs for them (a failing hook is logged and does not stop the rest). Returns how many jobs expired.
 */
export async function expireOldHelperJobs(target: D1Database | Env, now: Date, maxAgeDays: number = EXPIRE_AFTER_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const expired = (await dbOf(target).prepare(
    `UPDATE helper_jobs SET status = 'expired', error = ?, done_at = ? WHERE status IN ('pending','claimed') AND created_at < ? RETURNING kind, payload`,
  ).bind(`expired: nobody finished it within ${maxAgeDays} days`, now.toISOString(), cutoff).all<{ kind: string; payload: string }>()).results;
  if ("DB" in target) {
    for (const j of expired) {
      const hook = getHelperKind(j.kind)?.onExpire;
      if (!hook) continue;
      try { await hook(target, JSON.parse(j.payload)); }
      catch (e) { console.error("helper onExpire failed for", j.kind, e); }
    }
  }
  return expired.length;
}

/** Whether a device was seen lately, when, and the open jobs (pending or claimed) per kind: what the Today card and the video editor show. Revoked devices do not count. */
export async function helperStatus(db: D1Database, now: Date): Promise<{ online: boolean; lastSeenAt: string | null; pending: Record<string, number> }> {
  const seen = await db.prepare(`SELECT MAX(last_seen_at) AS at FROM helper_devices WHERE revoked_at IS NULL`).first<{ at: string | null }>();
  const rows = (await db.prepare(`SELECT kind, COUNT(*) AS n FROM helper_jobs WHERE status IN ('pending','claimed') GROUP BY kind`).all<{ kind: string; n: number }>()).results;
  const lastSeenAt = seen?.at ?? null;
  return {
    online: lastSeenAt !== null && now.getTime() - Date.parse(lastSeenAt) <= ONLINE_WITHIN_MS,
    lastSeenAt,
    pending: Object.fromEntries(rows.map((r) => [r.kind, r.n])),
  };
}
