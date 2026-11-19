import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "../auth";
import type { Env } from "../env";
import { publicReport } from "../db/reports";
import { serveMedia } from "../video/media";
import { MAX_EVENT_BYTES, ViewEventSchema, recordEvent } from "../video/views";

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

/** The body's text, or null when it is more than `max` bytes. The stream is cut off at the limit, so a long body is never held. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  if (Number(req.headers.get("content-length")) > max) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

// The report page's watch beacon (open, play, progress, end). It always answers 204 with nothing in it: an unknown link, an unpublished video, a bad
// body and a failed write are all the same to the caller, so it learns nothing about which links exist. Pages that are only fetched never send it.
publicRoutes.post("/report/:token/events", async (c) => {
  const token = c.req.param("token");
  // The owner testing their own link is not a prospect watching it. The session cookie is same-site, so the beacon carries it (sendBeacon cannot leave it off);
  // a valid one means "the owner": answered like everything else, recorded as nothing. An invalid or expired cookie is just a stranger.
  const session = getCookie(c, "session");
  const owner = !!session && (await verifySession(c.env.SESSION_SECRET, session, Date.now()).catch(() => false));
  if (TOKEN.test(token) && !owner) {
    try {
      const text = await readCapped(c.req.raw, MAX_EVENT_BYTES);
      const body = text ? ViewEventSchema.safeParse(JSON.parse(text)) : null;
      if (body?.success) await recordEvent(c.env, token, body.data, new Date());
    } catch { /* not JSON, or the write failed: still nothing to say */ }
  }
  return c.body(null, 204);
});

publicRoutes.all("*", (c) => c.json({ error: "not found" }, 404));
