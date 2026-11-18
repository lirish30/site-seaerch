import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { listFixedCosts, setFixedCostActive } from "../db/fixedCosts";
import { spendStatus } from "../spend";

const PatchFixed = z.object({ active: z.boolean() });

export const spendRoutes = new Hono<{ Bindings: Env }>();

spendRoutes.get("/", async (c) => {
  const [status, fixedCosts] = await Promise.all([spendStatus(c.env.DB, new Date()), listFixedCosts(c.env.DB)]);
  return c.json({ ...status, fixedCosts });
});

spendRoutes.patch("/fixed-costs/:id", async (c) => {
  const parsed = PatchFixed.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", fields: parsed.error.flatten().fieldErrors }, 400);
  const id = c.req.param("id");
  if (!(await listFixedCosts(c.env.DB)).some((f) => f.id === id)) return c.json({ error: "fixed cost not found" }, 404);
  await setFixedCostActive(c.env.DB, id, parsed.data.active);
  return c.json({ ok: true });
});
