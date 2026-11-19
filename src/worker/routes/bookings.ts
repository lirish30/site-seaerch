import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parseConfig } from "../booking/config";
import { cancelBookingByOwner, markMeetingHeld } from "../booking/owner";
import { upcomingBookings } from "../db/bookings";
import { getSettings } from "../db/settings";

const DAY = 86_400_000;
/** How far ahead the owner's list looks. */
const AHEAD_DAYS = 90;

export const bookingRoutes = new Hono<{ Bindings: Env }>();

/**
 * The confirmed calls, soonest first (`?lead=<id>` for one lead): the ones still to come (90 days ahead) and any that started and were never marked, so
 * the owner can say what happened to them. Includes what the guest typed (the page shows it escaped) but never the guest's cancel token.
 */
bookingRoutes.get("/", async (c) => {
  const now = new Date();
  const lead = c.req.query("lead");
  const all = await upcomingBookings(c.env.DB, new Date(0), new Date(now.getTime() + AHEAD_DAYS * DAY));
  const labels = new Map(parseConfig((await getSettings(c.env.DB)).booking_config).budgetOptions.map((o) => [o.id, o.label]));
  // The budget as the person saw it ("$797–$1,999"), falling back to the stored id when the option has since been removed.
  return c.json((lead ? all.filter((b) => b.businessId === lead) : all).map(({ cancelToken: _secret, ...b }) => ({ ...b, budgetLabel: b.answers ? labels.get(b.answers.budgetId) ?? b.answers.budgetId : "" })));
});

const CancelBody = z.object({ noShow: z.boolean().optional() }).strict();

/** Logan cancels a booking, or marks it a no-show. Idempotent: a booking that is already cancelled or a no-show answers 200 and nothing is repeated. */
bookingRoutes.post("/:id/cancel", async (c) => {
  const parsed = CancelBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  const r = await cancelBookingByOwner(c.env, c.req.param("id"), parsed.data, new Date());
  return r.ok ? c.json(r.booking) : c.json({ error: r.error }, r.status);
});

/** Logan marks a recommendation meeting as held. */
bookingRoutes.post("/:id/held", async (c) => {
  const r = await markMeetingHeld(c.env, c.req.param("id"));
  return r.ok ? c.json(r.booking) : c.json({ error: r.error }, r.status);
});
