import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { logActivity } from "../db/activity";
import { requestCallPrep } from "../queue/callPrep";
import { OptionsEditSchema, offerOf, optionProblems, requestCallRecap } from "../queue/callRecap";
import { parseConfig } from "../booking/config";
import { bookRecommendation, suggestFollowups } from "../booking/followup";
import { bookingFor, markBookingHeld } from "../db/bookings";
import { listCurrentPackages } from "../db/packages";
import { getSettings } from "../db/settings";
import { DiscoveryNotesSchema, emptyNotes, hasNotes } from "../sales/notes";
import { STAGE_ORDER, DealInputError, DealMoveError, createDeal, getDeal, listDeals, moveDeal, openDealFor, saveNotes, saveOptions, type Deal } from "../db/deals";

const StartBody = z.object({ skipCall: z.boolean().optional() }).strict();
const MoveBody = z.object({ to: z.enum(STAGE_ORDER), lostReason: z.string().trim().max(500).optional() }).strict();
const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

export const dealRoutes = new Hono<{ Bindings: Env }>();

dealRoutes.get("/", async (c) => c.json(await listDeals(c.env.DB, { openOnly: c.req.query("open") === "1" })));

dealRoutes.get("/:id", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  return deal ? c.json(deal) : c.json({ error: "not found" }, 404);
});

dealRoutes.post("/:id/move", async (c) => {
  const parsed = MoveBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (parsed.data.to === "lost" && !parsed.data.lostReason) return c.json({ error: "invalid body", fields: { lostReason: ["a lost deal needs a reason"] } }, 400);
  try {
    const moved = await moveDeal(c.env.DB, deal.id, parsed.data.to, { lostReason: parsed.data.lostReason });
    await logActivity(c.env.DB, deal.businessId, "deal_moved", moved.stage === "lost" ? `${deal.stage} -> lost: ${moved.lostReason}` : `${deal.stage} -> ${moved.stage}`);
    return c.json(moved);
  } catch (e) {
    if (e instanceof DealMoveError) return c.json({ error: e.message }, 409);
    if (e instanceof DealInputError) return c.json({ error: "invalid body", fields: { lostReason: [e.message] } }, 400);
    throw e;
  }
});

/** Asks Claude for the deal's call prep again. One prep is open at a time: while one is queued or claimed, a second ask returns `created: false` and changes nothing. */
dealRoutes.post("/:id/prep", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (deal.stage === "won" || deal.stage === "lost") return c.json({ error: "the deal is closed" }, 409);
  const { taskId, created } = await requestCallPrep(c.env.DB, deal.id);
  return c.json({ queued: true, created, taskId });
});

const BookBody = z.object({ start: z.string().trim().min(1).max(40) }).strict();
const isClosed = (d: Deal) => d.stage === "won" || d.stage === "lost";

/** Logan's notes from the discovery call. When the call was held is the server's to set (`call-done`), so it is kept from what is stored and never taken from the form. */
dealRoutes.put("/:id/notes", async (c) => {
  const parsed = DiscoveryNotesSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (isClosed(deal)) return c.json({ error: "the deal is closed" }, 409);
  await saveNotes(c.env.DB, deal.id, { ...parsed.data, callHeldAt: deal.notes?.callHeldAt ?? null });
  await logActivity(c.env.DB, deal.businessId, "call_recap", "Call notes saved");
  return c.json(await getDeal(c.env.DB, deal.id));
});

/** The discovery call happened: the booking is marked held, the notes are stamped with the time, and the deal moves to discovery_done. */
dealRoutes.post("/:id/call-done", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (deal.stage !== "booked") return c.json({ error: deal.skipCall ? "this deal skipped the call" : "the call is already marked done" }, 409);
  try { await moveDeal(c.env.DB, deal.id, "discovery_done"); }
  catch (e) { if (e instanceof DealMoveError) return c.json({ error: e.message }, 409); throw e; }
  await saveNotes(c.env.DB, deal.id, { ...(deal.notes ?? emptyNotes()), callHeldAt: new Date().toISOString() });
  const booking = await bookingFor(c.env.DB, deal.businessId, "discovery");
  if (booking) await markBookingHeld(c.env.DB, booking.id);
  await logActivity(c.env.DB, deal.businessId, "deal_moved", "booked -> discovery_done (call held)");
  return c.json(await getDeal(c.env.DB, deal.id));
});

/** Asks Claude for the recap and the three options from the notes. One recap is open at a time. */
dealRoutes.post("/:id/recap", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (isClosed(deal)) return c.json({ error: "the deal is closed" }, 409);
  if (!hasNotes(deal.notes)) return c.json({ error: "write the call notes first: the recap is built from the owner's own words" }, 409);
  const { taskId, created } = await requestCallRecap(c.env.DB, deal.id);
  if (created) await logActivity(c.env.DB, deal.businessId, "call_recap", "Call recap requested");
  return c.json({ queued: true, created, taskId });
});

/** Two recommendation-meeting times to offer on the call, from a fresh read of the calendar, with the zone to show them in. */
dealRoutes.get("/:id/followup-slots", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (isClosed(deal)) return c.json({ error: "the deal is closed" }, 409);
  try {
    const slots = await suggestFollowups(c.env, new Date());
    return c.json({ slots, tz: parseConfig((await getSettings(c.env.DB)).booking_config).timezone });
  } catch (e) {
    console.error("followup slots: could not read the calendar", e instanceof Error ? e.message : "unknown error");
    return c.json({ error: "could not read your calendar, please try again" }, 503);
  }
});

dealRoutes.post("/:id/book-recommendation", async (c) => {
  const parsed = BookBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  const r = await bookRecommendation(c.env, deal.id, parsed.data.start, new Date());
  if (!r.ok) return c.json({ error: r.error }, r.status);
  // Not the booking row itself: its cancel token is the guest's secret.
  return c.json({ booking: { id: r.booking.id, kind: r.booking.kind, start: r.booking.startAt, end: r.booking.endAt, meetUrl: r.booking.meetUrl } }, 201);
});

/** Logan's edit of the three options. Revalidated as Claude's are, and the prices are snapshotted again from the catalog as it is now. */
dealRoutes.put("/:id/options", async (c) => {
  const parsed = OptionsEditSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  if (isClosed(deal)) return c.json({ error: "the deal is closed" }, 409);
  const catalog = await listCurrentPackages(c.env.DB);
  const problems = optionProblems(parsed.data.options, { platform: deal.notes?.platform ?? "other", catalog });
  if (problems.length) return c.json({ error: "invalid options", problems }, 422);
  await saveOptions(c.env.DB, deal.id, offerOf(parsed.data.options, catalog));
  await logActivity(c.env.DB, deal.businessId, "call_recap", "Options edited");
  return c.json(await getDeal(c.env.DB, deal.id));
});

/** Mounted at /api/leads: starts a deal by hand. A lead with an open deal gets that deal back (200) and nothing is logged. */
export const leadDealRoutes = new Hono<{ Bindings: Env }>();

leadDealRoutes.post("/:id/deal", async (c) => {
  const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  const existing = await openDealFor(c.env.DB, id);
  if (existing) return c.json(existing, 200);
  const deal = await createDeal(c.env.DB, { businessId: id, source: "manual", skipCall: parsed.data.skipCall });
  await logActivity(c.env.DB, id, "deal_created", deal.skipCall ? "Deal started, call skipped" : "Deal started");
  return c.json(deal, 201);
});
