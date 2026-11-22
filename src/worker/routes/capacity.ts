import { Hono } from "hono";
import type { Env } from "../env";
import { computeCapacity } from "../capacity/compute";

export const capacityRoutes = new Hono<{ Bindings: Env }>();

/** This week and the next three: booked hours against the weekly limit, plus the client count against its limit. */
capacityRoutes.get("/", async (c) => c.json(await computeCapacity(c.env.DB, new Date())));
