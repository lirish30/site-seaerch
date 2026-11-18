import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import "../queue/kinds"; // registers every task kind, so the counts and labels below cover all of them
import { cancelTasksFor, getTask, queueCounts, releaseTask } from "../queue/db";
import { getTaskKind } from "../queue/registry";

const Cancel = z.object({ targetType: z.string().min(1).max(100), targetId: z.string().min(1).max(200) });

export const queueRoutes = new Hono<{ Bindings: Env }>();

/**
 * How much Claude work is open, for the Today card. Read only, and it never returns a task's payload or result (both can hold text copied from a
 * website or an inbox): counts per kind, each kind's label, and when the oldest pending task was queued. Like the `queue_status` tool, only kinds
 * that are registered are listed, so the numbers never include work no session could pick up.
 */
queueRoutes.get("/", async (c) => {
  const counts = Object.fromEntries(Object.entries(await queueCounts(c.env.DB)).filter(([kind]) => getTaskKind(kind)));
  const labels = Object.fromEntries(Object.keys(counts).map((kind) => [kind, getTaskKind(kind)!.label]));
  const kinds = Object.keys(counts);
  const oldest = kinds.length === 0 ? null : await c.env.DB.prepare(
    `SELECT MIN(created_at) AS at FROM claude_tasks WHERE status = 'pending' AND kind IN (${kinds.map(() => "?").join(",")})`,
  ).bind(...kinds).first<{ at: string | null }>();
  return c.json({ counts, labels, oldestPendingAt: oldest?.at ?? null });
});

/** Gives up on the open tasks about one target (a lead or an audit, say): they end `stale`, and the count comes back. */
queueRoutes.post("/cancel", async (c) => {
  const p = Cancel.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "targetType and targetId are required" }, 400);
  return c.json({ cancelled: await cancelTasksFor(c.env.DB, p.data.targetType, p.data.targetId) });
});

/**
 * Hands a task that is being worked back to the queue (its session died, say). Only a claimed task can be released: it goes back to pending, or fails
 * when it has used all its claims, which runs its kind's `onFail` hook (hence the whole `env`).
 */
queueRoutes.post("/:id/release", async (c) => {
  const id = c.req.param("id");
  if (!(await getTask(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  if (!(await releaseTask(c.env, id, "released by hand from the app"))) return c.json({ error: "that task is not being worked on" }, 409);
  return c.json({ ok: true });
});
