import { Hono } from "hono";
import type { Env } from "../env";
import { publicReport } from "../db/reports";

// Unauthenticated surface: keep it tiny. Every response (including 404s) is non-cacheable and non-indexable.
export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.use("*", async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

publicRoutes.get("/report/:token", async (c) => {
  const token = c.req.param("token");
  // Unknown, expired, revoked and malformed tokens are indistinguishable.
  if (!TOKEN.test(token)) return c.json({ error: "not found" }, 404);
  const report = await publicReport(c.env.DB, token);
  return report ? c.json(report) : c.json({ error: "not found" }, 404);
});

publicRoutes.all("*", (c) => c.json({ error: "not found" }, 404));
