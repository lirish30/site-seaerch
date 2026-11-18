import { env } from "cloudflare:test";
import { latestDraft } from "../../src/worker/db/drafts";
import { buildBundle } from "../../src/worker/queue/bundle";
import { completeTask, getTask } from "../../src/worker/queue/db";
import { requestDraft, type DraftOptions } from "../../src/worker/queue/leadDraft";
import type { Draft } from "../../src/worker/types";

/** Hands out one task, as the MCP tool would (the queue's own claim takes the oldest, which is not always the one a test is about). */
export async function claimById(id: string) {
  await env.DB.prepare(`UPDATE claude_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`)
    .bind(new Date().toISOString(), id).run();
  return (await getTask(env.DB, id))!;
}

/** A well-formed draft result with three variants. */
export const three = (tag = "") => ({
  variants: [1, 2, 3].map((n) => ({ angle: `Angle ${n}`, subject: `Subject ${n}${tag}`, body: `Body ${n}${tag}` })),
  to_contact_id: null, recipient_reason: "r",
});

/**
 * The whole queue round trip for one lead, as the old synchronous `regenerateDraft` did it: queue the draft, claim it, read what Claude would be
 * shown (`reply` may be a function of that text, so a test can assert on the prompt), complete it with the reply, and return the lead's current draft.
 */
export async function writeDraft(businessId: string, o: DraftOptions = {}, reply: Record<string, unknown> | ((shown: string) => unknown) = three()): Promise<Draft> {
  const { taskId } = await requestDraft(env.DB, businessId, o);
  const task = await claimById(taskId);
  const bundle = await buildBundle(env, task);
  if ("stale" in bundle) throw new Error(`stale: ${bundle.stale}`);
  const r = await completeTask(env, taskId, typeof reply === "function" ? reply(bundle.text) : reply);
  if (!r.ok) throw new Error(r.error);
  return (await latestDraft(env.DB, businessId))!;
}
