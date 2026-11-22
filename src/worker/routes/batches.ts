import { Hono } from "hono";
import type { Env } from "../env";
import { listBatches } from "../batches/groups";

export const batchRoutes = new Hono<{ Bindings: Env }>();

/** The batch board: each recurring template's current period (and the last one while work is open) across live, real clients. Read only. */
batchRoutes.get("/", async (c) => c.json({ groups: await listBatches(c.env.DB, new Date()) }));
