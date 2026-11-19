import { Hono } from "hono";
import { onInvoicePaid } from "../documents/deposit";
import type { Env } from "../env";
import { handleStripeEvent, verifyStripeSignature, type StripeEvent } from "../stripe/webhook";

/** Stripe's events are a few KB; anything near this is not one. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** The body as text, or null when it is longer than the cap (the stream is cancelled the moment it passes it). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

const isEvent = (v: any): v is StripeEvent =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof v.id === "string" && v.id.length > 0 && typeof v.type === "string" && v.type.length > 0;

/**
 * Stripe's webhook. Mounted outside /api/*, so it has no session: the signature is the only credential.
 * Answers carry no body. 503 secret not set, or this event is being handled by another delivery; 413 too large; 400 bad signature or not an event; 500 our own write failed (Stripe retries);
 * 200 for everything else, applied or not (a duplicate, an event we ignore or a payment that did not match), so Stripe stops retrying.
 */
export const stripeWebhookRoutes = new Hono<{ Bindings: Env }>();

stripeWebhookRoutes.post("/", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.body(null, 503);
  const raw = await readCapped(c.req.raw, MAX_WEBHOOK_BYTES);
  if (raw === null) return c.body(null, 413);
  if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature") ?? null, secret, Math.floor(Date.now() / 1000)))) return c.body(null, 400);
  let event: unknown;
  try { event = JSON.parse(raw); } catch { return c.body(null, 400); }
  if (!isEvent(event)) return c.body(null, 400);
  try {
    // Another delivery of the same event still in flight: 503, so Stripe retries later.
    if ((await handleStripeEvent(c.env, event, { onPaid: onInvoicePaid })) === "busy") return c.body(null, 503);
  } catch (e) {
    // The event id and the error's message only: never the body, which carries a client's details.
    console.error("stripe webhook: could not apply", event.id, e instanceof Error ? e.message : "unknown error");
    return c.body(null, 500);
  }
  return c.body(null, 200);
});
