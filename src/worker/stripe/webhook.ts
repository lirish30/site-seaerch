import { claimEvent, finishEvent, getInvoiceByStripeId, markInvoice, releaseEvent, type InvoiceRow, type InvoiceStatus } from "../db/invoices";
import type { Env } from "../env";

const enc = new TextEncoder();
export const SIGNATURE_TOLERANCE_SEC = 300;
const HEX64 = /^[0-9a-f]{64}$/i;

const hexBytes = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

/**
 * Stripe-Signature is `t=<unix>,v1=<hex>[,v1=<hex>...]`; v1 is an HMAC-SHA256 of `${t}.${rawBody}` under the endpoint secret.
 * Fails closed: an empty secret, a missing or malformed header, a repeated timestamp, a timestamp more than `toleranceSec` from now (either way) or no matching v1.
 * The comparison is WebCrypto's own verify, which is constant-time.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec: number, toleranceSec = SIGNATURE_TOLERANCE_SEC): Promise<boolean> {
  if (!header || !secret) return false;
  const ts: string[] = [], sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") ts.push(v); else if (k === "v1") sigs.push(v);
  }
  if (ts.length !== 1 || !/^\d{1,15}$/.test(ts[0]) || sigs.length === 0) return false;
  const t = Number(ts[0]);
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = enc.encode(`${ts[0]}.${rawBody}`);
  let ok = false;
  for (const s of sigs) {
    if (!HEX64.test(s)) continue;
    // No early exit: every candidate is checked.
    if (await crypto.subtle.verify("HMAC", key, hexBytes(s), signed)) ok = true;
  }
  return ok;
}

/** The part of a Stripe event this app reads. */
export interface StripeEvent { id: string; type: string; data: { object: Record<string, any> } }
/** `busy`: another delivery of this event is being handled right now; the route answers 503 so Stripe tries again later. */
export type StripeResult = "applied" | "duplicate" | "ignored" | "mismatch" | "busy";

const MAX_NOTE = 200;
const str = (v: unknown): string => String(v ?? "").slice(0, 40);

/**
 * What an invoice.paid says that we do not agree with, or null when it matches: the amount paid is exactly the cents we invoiced, in dollars,
 * and the invoice was made for this document (the metadata we set when creating it).
 */
export function paidProblem(inv: InvoiceRow, obj: Record<string, any>): string | null {
  const problems: string[] = [];
  if (obj.amount_paid !== inv.amountCents) problems.push(`amount paid ${str(obj.amount_paid)} is not the ${inv.amountCents} invoiced`);
  if (obj.currency !== "usd") problems.push(`currency ${str(obj.currency)} is not usd`);
  const doc = obj.metadata && typeof obj.metadata === "object" ? obj.metadata.document_id : undefined;
  if (doc !== inv.documentId) problems.push(`document ${str(doc)} is not the invoiced one`);
  return problems.length ? problems.join("; ").slice(0, MAX_NOTE) : null;
}

/** Where each event type takes an invoice, and the states it may not take it out of (a late or replayed event never undoes a payment or a void). */
const MOVES: Record<string, { to: InvoiceStatus; notFrom: InvoiceStatus[] }> = {
  "invoice.voided": { to: "void", notFrom: ["paid"] },
  "invoice.marked_uncollectible": { to: "uncollectible", notFrom: ["paid", "void"] },
  "invoice.payment_failed": { to: "failed", notFrom: ["paid", "void", "uncollectible"] },
};

async function apply(env: Env, event: StripeEvent, deps: StripeDeps): Promise<StripeResult> {
  const isPaid = event.type === "invoice.paid";
  if (!isPaid && !MOVES[event.type]) return "ignored";
  const obj = event.data?.object;
  if (!obj || typeof obj.id !== "string") return "ignored";
  const inv = await getInvoiceByStripeId(env.DB, obj.id);
  if (!inv) return "ignored"; // another product on the same Stripe account, or an invoice we did not make

  if (!isPaid) {
    const move = MOVES[event.type];
    return (await markInvoice(env.DB, inv.id, { status: move.to }, { notFrom: move.notFrom })) ? "applied" : "ignored";
  }

  const problem = paidProblem(inv, obj);
  if (problem) {
    // Guarded like the moves: a note never lands on an invoice that is already paid or void.
    await markInvoice(env.DB, inv.id, { mismatch: problem }, { notFrom: ["paid", "void"] });
    return "mismatch";
  }
  // A retry after a failed onPaid keeps the first paid time.
  await markInvoice(env.DB, inv.id, { status: "paid", paidAt: inv.paidAt ?? new Date().toISOString(), mismatch: null });
  // onPaid runs for every paid event that is not a duplicate, including the retry of one whose onPaid threw: it must be safe to run twice.
  if (deps.onPaid) await deps.onPaid(env, (await getInvoiceByStripeId(env.DB, inv.stripeInvoiceId))!);
  return "applied";
}

export interface StripeDeps { onPaid?: (env: Env, inv: InvoiceRow) => Promise<void>; /** The clock, for the event lease. */ now?: () => Date }

/**
 * Handles one verified event, claiming it first: the id is inserted with no processed time, and only the caller that holds the claim applies it.
 * Another delivery of an event that is finished is a `duplicate`, and of one whose claim is under 2 minutes old a `busy` (the route answers 503).
 * An unfinished claim older than that (the Worker died, or the release below failed) is taken over, so an event is never lost as "processed".
 * The event is marked processed only after the state update and onPaid have succeeded. On any failure the claim is released (dated to the epoch) and the
 * error rethrown, which the route turns into a 500; the retry re-claims at once. onPaid can therefore run again for the same event: it must be idempotent.
 */
export async function handleStripeEvent(env: Env, event: StripeEvent, deps: StripeDeps = {}): Promise<StripeResult> {
  const now = deps.now ?? (() => new Date());
  const claim = await claimEvent(env.DB, event.id, event.type, now());
  if (claim !== "claimed") return claim;
  try {
    const result = await apply(env, event, deps);
    await finishEvent(env.DB, event.id, now());
    return result;
  } catch (e) {
    // Never delete the row: a failed release only means the next delivery waits for the lease. Log the id, not the payload.
    await releaseEvent(env.DB, event.id).catch(() => console.error("stripe webhook: could not release the claim on event", event.id));
    throw e;
  }
}
