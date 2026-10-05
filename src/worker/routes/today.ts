import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { logActivity } from "../db/activity";
import { buildToday, isTodayKind, snoozeDetail } from "../today";

const Snooze = z.object({ days: z.number({ error: "days must be a whole number from 1 to 30" }).int("days must be a whole number from 1 to 30").min(1, "days must be from 1 to 30").max(30, "days must be from 1 to 30") });

export const todayRoutes = new Hono<{ Bindings: Env }>();

todayRoutes.get("/", async (c) => c.json({ items: await buildToday(c.env.DB, new Date()) }));

/** The kind must be one of the Today kinds and the lead must exist, else 404. */
async function target(c: { env: Env; req: { param: (k: string) => string } }) {
  const kind = c.req.param("kind"), id = c.req.param("businessId");
  if (!isTodayKind(kind) || !(await getBusiness(c.env.DB, id))) return null;
  return { kind, id };
}

todayRoutes.post("/:kind/:businessId/done", async (c) => {
  const t = await target(c);
  if (!t) return c.json({ error: "not found" }, 404);
  await logActivity(c.env.DB, t.id, "today_done", t.kind);
  return c.json({ ok: true });
});

todayRoutes.post("/:kind/:businessId/snooze", async (c) => {
  const t = await target(c);
  if (!t) return c.json({ error: "not found" }, 404);
  const parsed = Snooze.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "days must be from 1 to 30" }, 400);
  const until = new Date(Date.now() + parsed.data.days * 86_400_000);
  await logActivity(c.env.DB, t.id, "snoozed", snoozeDetail(t.kind, until));
  return c.json({ ok: true, until: until.toISOString() });
});
