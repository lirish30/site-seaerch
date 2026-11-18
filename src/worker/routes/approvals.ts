import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { listApprovals, pendingCounts } from "../db/approvals";
import { approve, reject } from "../approvals/decide";
import { getHandler } from "../approvals/registry";

const Status = z.enum(["pending", "approved", "rejected"]);
const ApproveBody = z.object({ payload: z.unknown().optional() });
const RejectBody = z.object({ note: z.string().max(500).optional() });
const BatchBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(50) });

export const approvalRoutes = new Hono<{ Bindings: Env }>();

approvalRoutes.get("/", async (c) => {
  const s = c.req.query("status");
  const status = s === undefined ? undefined : Status.safeParse(s);
  if (status && !status.success) return c.json({ error: "invalid status", fields: { status: ["pending, approved or rejected"] } }, 400);
  const [rows, counts] = await Promise.all([listApprovals(c.env.DB, { status: status?.data }), pendingCounts(c.env.DB)]);
  return c.json({ items: rows.map((a) => ({ ...a, label: getHandler(a.kind)?.label ?? a.kind })), counts });
});

// Registered before "/:id/..." so "approve-batch" is never read as an id.
approvalRoutes.post("/approve-batch", async (c) => {
  const p = BatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid body", fields: p.error.flatten().fieldErrors }, 400);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of p.data.ids) { // one at a time: handlers may share rate limits and inboxes
    try {
      const r = await approve(c.env, id);
      results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ results });
});

approvalRoutes.post("/:id/approve", async (c) => {
  const p = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid body", fields: p.error.flatten().fieldErrors }, 400);
  const r = await approve(c.env, c.req.param("id"), p.data.payload);
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
});

approvalRoutes.post("/:id/reject", async (c) => {
  const p = RejectBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid body", fields: p.error.flatten().fieldErrors }, 400);
  const id = c.req.param("id");
  if (await reject(c.env.DB, id, p.data.note)) return c.json({ ok: true });
  const exists = await c.env.DB.prepare(`SELECT 1 AS x FROM approvals WHERE id = ?`).bind(id).first();
  return c.json({ error: exists ? "already decided" : "approval not found" }, exists ? 409 : 404);
});
