import type { Env } from "../env";
import { CRO_SYNTH_KIND, CRO_TARGET } from "../queue/cro";
import { enqueueTask } from "../queue/db";

/** Whether the audit has a roadmap task a worker could pick up (any try). */
async function roadmapIsOpen(db: D1Database, auditId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM claude_tasks WHERE kind = ? AND target_type = ? AND target_id = ? AND status IN ('pending','claimed') LIMIT 1`)
    .bind(CRO_SYNTH_KIND, CRO_TARGET, auditId).first());
}

/**
 * Hands a finished set of page reviews over to the roadmap stage by queueing the `cro.synthesize` task. Called once the last page is in (or skipped),
 * and again by a crash-retry of that, or by any page task of the audit ending later, so it must be idempotent: the task's dedupe key is the audit id,
 * and an audit whose roadmap is already open at its second try (the first is finished by then, so its key no longer guards) is left alone too.
 * A roadmap that was written leaves nothing to hand over: its audit is no longer waiting, and the caller checks that first.
 */
export async function startSynthesis(env: Env, auditId: string): Promise<void> {
  if (await roadmapIsOpen(env.DB, auditId)) return;
  await enqueueTask(env.DB, CRO_SYNTH_KIND, { auditId, attempt: 1 }, { dedupeKey: auditId, targetType: CRO_TARGET, targetId: auditId });
}
