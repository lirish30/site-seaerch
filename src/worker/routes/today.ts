import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { upcomingBookings } from "../db/bookings";
import { logActivity } from "../db/activity";
import { computeCapacity } from "../capacity/compute";
import { buildToday, isTodayKind, snoozeDetail } from "../today";
import { buildSummary } from "../todaySummary";

const Snooze = z.object({ days: z.number({ error: "days must be a whole number from 1 to 30" }).int("days must be a whole number from 1 to 30").min(1, "days must be from 1 to 30").max(30, "days must be from 1 to 30") });

export const todayRoutes = new Hono<{ Bindings: Env }>();

todayRoutes.get("/", async (c) => {
  const now = new Date();
  // The capacity card rides along, but never stops the list: a failed read leaves `capacity` null and the client shows a retry in its place.
  const capacityOrNull = () => computeCapacity(c.env.DB, now).catch((e) => { console.error("today: capacity failed", e); return null; });
  const [items, capacity] = await Promise.all([buildToday(c.env.DB, now), capacityOrNull()]);
  return c.json({ items, capacity });
});

/**
 * The confirmed calls for the Calls card: the next 7 days, and any that have started without being marked (held, cancelled or a no-show), who, when, what
 * kind and the Meet link. Nothing the guest answered on the form leaves here, and never their cancel token.
 */
todayRoutes.get("/calls", async (c) => {
  const now = new Date();
  const all = await upcomingBookings(c.env.DB, new Date(0), new Date(now.getTime() + 7 * 86_400_000));
  return c.json({ calls: all.map((b) => ({ id: b.id, businessId: b.businessId, businessName: b.businessName, contactName: b.contactName, startAt: b.startAt, meetUrl: b.meetUrl, kind: b.kind, dealId: b.dealId })) });
});

/** The Home KPI cards, pipeline counts and recent activity. */
todayRoutes.get("/summary", async (c) => c.json(await buildSummary(c.env.DB, new Date())));

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
