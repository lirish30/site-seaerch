import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { listFixedCosts, setFixedCostActive } from "../db/fixedCosts";
import { SERVICES, setSpendCap } from "../db/spendCaps";
import { serviceSpend, spendStatus } from "../spend";

const PatchFixed = z.object({ active: z.boolean() });
const PutCap = z.object({ monthlyUsd: z.number().min(0).max(1000).nullable() });
const ServiceName = z.enum(SERVICES);

export const spendRoutes = new Hono<{ Bindings: Env }>();

spendRoutes.get("/", async (c) => {
  const now = new Date();
  const [status, fixedCosts, services] = await Promise.all([spendStatus(c.env.DB, now), listFixedCosts(c.env.DB), serviceSpend(c.env.DB, now)]);
  return c.json({ ...status, fixedCosts, services });
});

spendRoutes.put("/caps/:service", async (c) => {
  const service = ServiceName.safeParse(c.req.param("service"));
  if (!service.success) return c.json({ error: "unknown service", fields: { service: ["Unknown service."] } }, 400);
  const parsed = PutCap.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", fields: parsed.error.flatten().fieldErrors }, 400);
  await setSpendCap(c.env.DB, service.data, parsed.data.monthlyUsd);
  return c.json({ services: await serviceSpend(c.env.DB, new Date()) });
});

spendRoutes.patch("/fixed-costs/:id", async (c) => {
  const parsed = PatchFixed.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", fields: parsed.error.flatten().fieldErrors }, 400);
  const id = c.req.param("id");
  if (!(await listFixedCosts(c.env.DB)).some((f) => f.id === id)) return c.json({ error: "fixed cost not found" }, 404);
  await setFixedCostActive(c.env.DB, id, parsed.data.active);
  return c.json({ ok: true });
});
