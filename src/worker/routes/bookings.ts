import { Hono } from "hono";
import type { Env } from "../env";
import { parseConfig } from "../booking/config";
import { upcomingBookings } from "../db/bookings";
import { getSettings } from "../db/settings";

const DAY = 86_400_000;
/** How far ahead the owner's list looks. */
const AHEAD_DAYS = 90;

export const bookingRoutes = new Hono<{ Bindings: Env }>();

/** The confirmed calls that have not started yet, soonest first (`?lead=<id>` for one lead). Includes what the guest typed: the page shows it escaped. */
bookingRoutes.get("/", async (c) => {
  const now = new Date();
  const lead = c.req.query("lead");
  const all = await upcomingBookings(c.env.DB, now, new Date(now.getTime() + AHEAD_DAYS * DAY));
  const labels = new Map(parseConfig((await getSettings(c.env.DB)).booking_config).budgetOptions.map((o) => [o.id, o.label]));
  // The budget as the person saw it ("$797–$1,999"), falling back to the stored id when the option has since been removed.
  return c.json((lead ? all.filter((b) => b.businessId === lead) : all).map((b) => ({ ...b, budgetLabel: b.answers ? labels.get(b.answers.budgetId) ?? b.answers.budgetId : "" })));
});
