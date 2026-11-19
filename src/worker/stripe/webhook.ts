import { forgetEvent, getInvoiceByStripeId, markInvoice, recordEvent, type InvoiceRow, type InvoiceStatus } from "../db/invoices";
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
export type StripeResult = "applied" | "duplicate" | "ignored" | "mismatch";

const MAX_NOTE = 200;
const str = (v: unknown): string => String(v ?? "").slice(0, 40);

/**
 * What an invoice.paid says that we do not agree with, or null when it matches: the amount paid is exactly the cents we invoiced, in dollars,
 * and the invoice was made for this document (the metadata we set when creating it).
 */
function paidProblem(inv: InvoiceRow, obj: Record<string, any>): string | null {
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
    await markInvoice(env.DB, inv.id, { mismatch: problem });
    return "mismatch";
  }
  // A retry after a failed onPaid keeps the first paid time.
  await markInvoice(env.DB, inv.id, { status: "paid", paidAt: inv.paidAt ?? new Date().toISOString(), mismatch: null });
  // onPaid runs for every paid event that is not a duplicate, including the retry of one whose onPaid threw: it must be safe to run twice.
  if (deps.onPaid) await deps.onPaid(env, (await getInvoiceByStripeId(env.DB, inv.stripeInvoiceId))!);
  return "applied";
}

export interface StripeDeps { onPaid?: (env: Env, inv: InvoiceRow) => Promise<void> }

/**
 * Handles one verified event. The event id is inserted FIRST (INSERT OR IGNORE), so a repeat, or two deliveries at once, is a `duplicate` that does nothing.
 * If anything after that throws (our database, or onPaid), the id is deleted again before the error goes up, so Stripe's retry of the same event is
 * handled afresh instead of being swallowed as a duplicate. A throw therefore means "retry me"; the route turns it into a 500.
 */
export async function handleStripeEvent(env: Env, event: StripeEvent, deps: StripeDeps = {}): Promise<StripeResult> {
  if (!(await recordEvent(env.DB, event.id, event.type))) return "duplicate";
  try {
    return await apply(env, event, deps);
  } catch (e) {
    await forgetEvent(env.DB, event.id).catch(() => {});
    throw e;
  }
}
