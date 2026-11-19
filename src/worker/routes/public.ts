import { Hono } from "hono";
import type { Env } from "../env";
import { publicReport } from "../db/reports";
import { serveMedia } from "../video/media";

// Unauthenticated surface: keep it tiny. Every response (including 404s) is non-indexable and, apart from the video files below, non-cacheable.
export const publicRoutes = new Hono<{ Bindings: Env; Variables: { media?: boolean } }>();

publicRoutes.use("*", async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex, nofollow");
  // Only a media response a handler has marked (a served file) keeps the cache header it set; everything else, errors included, is no-store.
  if (!c.get("media")) c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

// Tokens are always exactly 43 chars (32 bytes, base64url), so anything else never touches the DB.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

publicRoutes.get("/report/:token", async (c) => {
  const token = c.req.param("token");
  // Unknown, expired, revoked and malformed tokens are indistinguishable.
  if (!TOKEN.test(token)) return c.json({ error: "not found" }, 404);
  const report = await publicReport(c.env.DB, token);
  return report ? c.json(report) : c.json({ error: "not found" }, 404);
});

// The published video's files: video.mp4, poster.jpg, preview.gif. Streamed from storage, with byte ranges so a player can seek.
publicRoutes.get("/report/:token/media/:name", async (c) => {
  const res = await serveMedia(c.env, c.req.param("token"), c.req.param("name"), c.req.header("range") ?? null);
  if (res.status === 200 || res.status === 206) c.set("media", true);
  return res;
});

publicRoutes.all("*", (c) => c.json({ error: "not found" }, 404));
