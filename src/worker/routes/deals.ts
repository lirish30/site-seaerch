import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { logActivity } from "../db/activity";
import { STAGE_ORDER, DealInputError, DealMoveError, createDeal, getDeal, listDeals, moveDeal, openDealFor } from "../db/deals";

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
