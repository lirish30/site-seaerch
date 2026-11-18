import { Hono } from "hono";
import type { Env } from "../env";
import { nicheReport } from "../niche";

export const nicheRoutes = new Hono<{ Bindings: Env }>();

nicheRoutes.get("/", async (c) => {
  const { rows, verdict } = await nicheReport(c.env.DB);
  return c.json({ rows, verdict });
});
