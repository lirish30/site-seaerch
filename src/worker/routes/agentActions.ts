import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { listAgentActions } from "../db/agentActions";

const Query = z.object({
  record_type: z.string().min(1).optional(),
  record_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const agentActionRoutes = new Hono<{ Bindings: Env }>();

agentActionRoutes.get("/", async (c) => {
  const p = Query.safeParse(c.req.query());
  if (!p.success) return c.json({ error: "invalid query", fields: p.error.flatten().fieldErrors }, 400);
  return c.json({ items: await listAgentActions(c.env.DB, p.data) });
});
