import { Hono } from "hono";
import type { Env } from "../env";
import { requestMeetilySync } from "../meetings/syncKind";

/** Mounted at /api (behind requireAuth): /meetings/sync, and the rest of the meetings routes beside it. */
export const meetingRoutes = new Hono<{ Bindings: Env }>();

/** "Sync now": asks the Mac helper to pull Meetily's recent recordings, as the 15-minute cron does. Says whether a job was queued, and why not. */
meetingRoutes.post("/meetings/sync", async (c) => c.json(await requestMeetilySync(c.env, new Date())));
