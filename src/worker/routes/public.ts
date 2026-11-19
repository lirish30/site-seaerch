import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "../auth";
import type { Env } from "../env";
import { z } from "zod";
import { BookingFormSchema, bookingPage, cancelByToken, createVisitorBooking } from "../booking/create";
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
  const report = await publicReport(c.env.DB, token, new Date(), { linkBase: c.env.OUTREACH_LINK_BASE });
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

// The booking page (Plan 4). Every answer for a link that is gone, and for a lead that may not be contacted, is the same 404; a malformed token never
// reaches the database. What a person types here is stored as typed and is never part of a response.
const MAX_BOOK_BYTES = 8 * 1024;
const NOT_FOUND = { error: "not found" } as const;
const CancelBody = z.object({ cancelToken: z.string().regex(TOKEN) }).strict();

/** The JSON body, capped at 8 KB: the body, or the response that refuses it (413 too long, 400 not JSON). */
async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const text = await readCapped(req, MAX_BOOK_BYTES);
  if (text === null) return { ok: false, status: 413 };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, status: 400 }; }
}

// Every cold-outreach recipient holds a valid link, and a booking page read costs a Google token refresh and a free/busy call, so each booking route is
// limited per link and client IP. The binding is optional (local and test runs without it are not limited), as with the login limiter.
const bookingLimited: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = c.req.param("token") ?? "";
  const limiter = c.env.BOOKING_LIMITER;
  // A malformed token is a 404 that never touches anything, so it is not counted.
  if (limiter && TOKEN.test(token)) {
    const { success } = await limiter.limit({ key: `${token}:${c.req.header("cf-connecting-ip") ?? "unknown"}` });
    if (!success) return c.json({ error: "too many requests" }, 429);
  }
  return next();
};
publicRoutes.use("/report/:token/book", bookingLimited);
publicRoutes.use("/report/:token/book/cancel", bookingLimited);

publicRoutes.get("/report/:token/book", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const r = await bookingPage(c.env, token, new Date());
  if (r.ok) return c.json(r.page);
  return r.status === 404 ? c.json(NOT_FOUND, 404) : c.json({ error: r.error, fallbackUrl: r.fallbackUrl ?? "" }, r.status);
});

publicRoutes.post("/report/:token/book", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw);
  if (!read.ok) return c.json({ error: read.status === 413 ? "too large" : "invalid body" }, read.status);
  const parsed = BookingFormSchema.safeParse(read.body);
  // Only the names of the fields that failed: what was typed is never echoed. A name that is refused for what it holds (an address) is a 422.
  if (!parsed.success) {
    const fields = Object.keys(z.flattenError(parsed.error).fieldErrors);
    const refusedName = parsed.error.issues.some((i) => i.path[0] === "name" && i.code === "custom");
    return c.json({ error: "invalid body", fields }, refusedName ? 422 : 400);
  }
  const r = await createVisitorBooking(c.env, token, parsed.data, new Date());
  if (!r.ok) return r.status === 404 ? c.json(NOT_FOUND, 404) : c.json({ error: r.error, ...(r.fallbackUrl !== undefined && { fallbackUrl: r.fallbackUrl }) }, r.status);
  const b = r.booking;
  return c.json({ booking: { start: b.startAt, end: b.endAt, meetUrl: b.meetUrl, cancelToken: b.cancelToken } }, 201);
});

publicRoutes.post("/report/:token/book/cancel", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw);
  if (!read.ok) return c.json({ error: read.status === 413 ? "too large" : "invalid body" }, read.status);
  const parsed = CancelBody.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  return c.json(await cancelByToken(c.env, token, parsed.data.cancelToken, new Date()));
});

publicRoutes.all("*", (c) => c.json({ error: "not found" }, 404));
