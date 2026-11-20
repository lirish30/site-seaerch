import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "../auth";
import type { Env } from "../env";
import { z } from "zod";
import { BookingFormSchema, bookingPage, cancelByToken, createVisitorBooking } from "../booking/create";
import { changeOrderPage, declineChangeOrderPublic, signChangeOrderPublic, type ChangeOrderWriteResult } from "../changeorders/public";
import { publicReport } from "../db/reports";
import { ensureDepositInvoice } from "../documents/deposit";
import { SignFormSchema, proposalPage, signProposal, signedProposalFor } from "../documents/public";
import { signedPdfResponse } from "../documents/signed";
import { MAX_UPLOAD_BODY, acceptUpload, checkUploadTarget, readBodyCapped, removeClientFile } from "../onboarding/files";
import { onboardingPage, saveClientAnswers, saveClientItemText, submitClientQuestionnaire, type WriteResult } from "../onboarding/public";
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
/** A sign request is a name, two booleans and a hash. */
const MAX_SIGN_BYTES = 4 * 1024;
const NOT_FOUND = { error: "not found" } as const;
const CancelBody = z.object({ cancelToken: z.string().regex(TOKEN) }).strict();

/** The JSON body, capped at `max` bytes (8 KB by default): the body, or the response that refuses it (413 too long, 400 not JSON). */
async function readJson(req: Request, max = MAX_BOOK_BYTES): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const text = await readCapped(req, max);
  if (text === null) return { ok: false, status: 413 };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, status: 400 }; }
}

// Every cold-outreach recipient holds a valid link, and a booking page read costs a Google token refresh and a free/busy call, so each booking route is
// limited per link and client IP. The binding is optional (local and test runs without it are not limited), as with the login limiter. A client's proposal
// link is limited the same way (its own binding), since its routes write: a view, and a signature.
const limitedBy = (binding: (env: Env) => RateLimit | undefined): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  const token = c.req.param("token") ?? "";
  const limiter = binding(c.env);
  // A malformed token is a 404 that never touches anything, so it is not counted.
  if (limiter && TOKEN.test(token)) {
    const { success } = await limiter.limit({ key: `${token}:${c.req.header("cf-connecting-ip") ?? "unknown"}` });
    if (!success) return c.json({ error: "too many requests" }, 429);
  }
  return next();
};
const bookingLimited = limitedBy((e) => e.BOOKING_LIMITER);
const clientLimited = limitedBy((e) => e.CLIENT_LIMITER);
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

// The client's proposal page and click-to-sign. The same 404 for every link that is not live; a malformed token never reaches the database. The typed name
// and the browser string are stored as typed and are only ever shown escaped.
publicRoutes.use("/p/:token", clientLimited);
publicRoutes.use("/p/:token/sign", clientLimited);
publicRoutes.use("/p/:token/pdf", clientLimited);
publicRoutes.use("/p/:token/pay", clientLimited);

publicRoutes.get("/p/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const page = await proposalPage(c.env, token, { now: new Date(), userAgent: c.req.header("user-agent") ?? null });
  return page ? c.json(page) : c.json(NOT_FOUND, 404);
});

publicRoutes.post("/p/:token/sign", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw, MAX_SIGN_BYTES);
  if (!read.ok) return c.json({ error: read.status === 413 ? "too large" : "invalid body" }, read.status);
  const parsed = SignFormSchema.safeParse(read.body);
  // Only the names of the fields that failed: what was typed is never echoed.
  if (!parsed.success) return c.json({ error: "invalid body", fields: Object.keys(z.flattenError(parsed.error).fieldErrors) }, 400);
  const r = await signProposal(c.env, token, parsed.data, { now: new Date(), ip: c.req.header("cf-connecting-ip") ?? null, userAgent: c.req.header("user-agent") ?? null });
  return r.ok ? c.json(r.page) : c.json({ error: r.error }, r.status);
});

// The signed PDF: only a signed document has one, and every other state (and every link that is not live) is the same 404. It is made on first request if
// signing did not make it.
publicRoutes.get("/p/:token/pdf", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const doc = await signedProposalFor(c.env, token);
  return doc ? signedPdfResponse(c.env, doc) : c.json(NOT_FOUND, 404);
});

// The deposit's payment page: asks for the invoice again (the retry when it could not be made at signing) and answers with where the payment stands. Only a
// signed document has one, and every other state is the same 404. There is nothing to read from the body, so it is not read.
publicRoutes.post("/p/:token/pay", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const doc = await signedProposalFor(c.env, token);
  return doc ? c.json(await ensureDepositInvoice(c.env, doc.id)) : c.json(NOT_FOUND, 404);
});

// The client's change-order page (Plan 7) and its two writes. The same 404 for every link that is not live (unknown, malformed, revoked, still a draft), and a malformed token
// never reaches the database. The token is looked up BEFORE the form is read, so a bad form on a link that is not real is a 404 and never a 400: the body is passed on as it came
// (not JSON is just a form that fails) and the service decides. A decline needs no body at all.
publicRoutes.use("/c/:token", clientLimited);
publicRoutes.use("/c/:token/sign", clientLimited);
publicRoutes.use("/c/:token/decline", clientLimited);

/** A change-order write's answer: the page, or the status and a fixed message (with the names of the fields that failed, never what was typed). */
const changeOrderReply = (c: Context, r: ChangeOrderWriteResult) =>
  r.ok ? c.json(r.page) : r.status === 404 ? c.json(NOT_FOUND, 404) : c.json({ error: r.error, ...(r.fields && { fields: r.fields }) }, r.status);

publicRoutes.get("/c/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const page = await changeOrderPage(c.env, token, { now: new Date(), userAgent: c.req.header("user-agent") ?? null });
  return page ? c.json(page) : c.json(NOT_FOUND, 404);
});

publicRoutes.post("/c/:token/sign", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw, MAX_SIGN_BYTES);
  if (!read.ok && read.status === 413) return c.json({ error: "too large" }, 413);
  const r = await signChangeOrderPublic(c.env, token, read.ok ? read.body : undefined, { now: new Date(), ip: c.req.header("cf-connecting-ip") ?? null, userAgent: c.req.header("user-agent") ?? null });
  return changeOrderReply(c, r);
});

publicRoutes.post("/c/:token/decline", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const text = await readCapped(c.req.raw, MAX_SIGN_BYTES);
  if (text === null) return c.json({ error: "too large" }, 413);
  let reason: unknown;
  // An empty or unreadable body is a no-thanks without a reason: turning an order down always works.
  try { const body: unknown = text ? JSON.parse(text) : null; reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined; } catch { reason = undefined; }
  return changeOrderReply(c, await declineChangeOrderPublic(c.env, token, reason, new Date()));
});

// The client's onboarding page (Plan 6): the same 404 for every link that is not live, and a malformed token never reaches the database. Only writes count as
// the client being here (a read records nothing). What the client types is cleaned and stored as typed text; an error names question ids and never repeats it.
// The answers can be all of the long questions at once, so they get a larger body limit than a booking form; item text is capped at 5000 characters.
const MAX_ANSWERS_BYTES = 64 * 1024;
const MAX_ITEM_TEXT_BYTES = 32 * 1024;
const AnswersBody = z.object({ answers: z.record(z.string(), z.string()) }).strict();
const ItemTextBody = z.object({ text: z.string() }).strict();
publicRoutes.use("/o/:token", clientLimited);
publicRoutes.use("/o/:token/answers", clientLimited);
publicRoutes.use("/o/:token/submit", clientLimited);
publicRoutes.use("/o/:token/items/:itemId/text", clientLimited);
publicRoutes.use("/o/:token/items/:itemId/files", clientLimited);
publicRoutes.use("/o/:token/files/:fileId", clientLimited);

/** A write's answer: 200 with `ok`, the same 404 as every dead link, and for the rest a fixed message with, when there are any, the ids that are wrong. */
const writeReply = (c: Context, r: WriteResult) => {
  if (r.ok) return c.json(r.already ? { ok: true, already: true } : { ok: true });
  if (r.status === 404) return c.json(NOT_FOUND, 404);
  return c.json({ error: r.error ?? "invalid body", ...(r.fields && { fields: r.fields }) }, r.status);
};

publicRoutes.get("/o/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const page = await onboardingPage(c.env, token, new Date());
  return page ? c.json(page) : c.json(NOT_FOUND, 404);
});

publicRoutes.put("/o/:token/answers", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw, MAX_ANSWERS_BYTES);
  if (!read.ok) return c.json({ error: read.status === 413 ? "too large" : "invalid body" }, read.status);
  const parsed = AnswersBody.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  return writeReply(c, await saveClientAnswers(c.env, token, parsed.data.answers, new Date()));
});

publicRoutes.post("/o/:token/submit", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  // There is nothing to read from the body, so it is not read.
  return writeReply(c, await submitClientQuestionnaire(c.env, token, new Date()));
});

publicRoutes.put("/o/:token/items/:itemId/text", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  const read = await readJson(c.req.raw, MAX_ITEM_TEXT_BYTES);
  if (!read.ok) return c.json({ error: read.status === 413 ? "too large" : "invalid body" }, read.status);
  const parsed = ItemTextBody.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  return writeReply(c, await saveClientItemText(c.env, token, c.req.param("itemId"), parsed.data.text, new Date()));
});

// A file for a checklist item: multipart, one `file` part. The link and the item are checked first, then the size from Content-Length, all before the body is
// read; the body is read only up to the limit however long it claims to be. The file's name is never echoed (an error is fixed text).
publicRoutes.post("/o/:token/items/:itemId/files", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  if (Number(c.req.header("content-length")) > MAX_UPLOAD_BODY) return c.json({ error: "too large" }, 413);
  const itemId = c.req.param("itemId");
  const ready = await checkUploadTarget(c.env, token, itemId);
  if (!ready.ok) return ready.status === 404 ? c.json(NOT_FOUND, 404) : c.json({ error: ready.error }, ready.status);
  const type = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type)) return c.json({ error: "invalid body" }, 400);
  const body = await readBodyCapped(c.req.raw, MAX_UPLOAD_BODY);
  if (!body) return c.json({ error: "too large" }, 413);
  let part: unknown;
  try { part = (await new Response(body as BodyInit, { headers: { "content-type": type } }).formData()).get("file"); } catch { return c.json({ error: "invalid body" }, 400); }
  if (!(part instanceof File)) return c.json({ error: "invalid body" }, 400);
  const r = await acceptUpload(c.env, token, itemId, part, new Date());
  if (r.ok) return c.json({ file: r.file }, 201);
  return r.status === 404 ? c.json(NOT_FOUND, 404) : c.json({ error: r.error }, r.status);
});

publicRoutes.delete("/o/:token/files/:fileId", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json(NOT_FOUND, 404);
  return writeReply(c, await removeClientFile(c.env, token, c.req.param("fileId"), new Date()));
});

publicRoutes.all("*", (c) => c.json({ error: "not found" }, 404));
