import { logActivity, logActivityOnce } from "../db/activity";
import { getBusiness, updateLead } from "../db/businesses";
import { DealMoveError, getDeal, moveDeal } from "../db/deals";
import { getDocument, setPaid, type Document } from "../db/documents";
import { getInvoiceForDocument, getStripeCustomer, insertInvoice, markInvoice, saveStripeCustomer, type InvoiceRow } from "../db/invoices";
import type { Env } from "../env";
import type { Fetch } from "../google/oauth";
import { startOnboarding } from "../onboarding/start";
import { startProjects } from "../projects/start";
import { stopOutreach } from "../sequence/stop";
import { StripeError, createCustomer, createDepositInvoice, retrieveInvoice, stripeMode } from "../stripe/client";
import { paidProblem } from "../stripe/webhook";

/** What the client's page says about the deposit. */
export type PublicPayment =
  | { state: "none" }
  | { state: "open"; amountCents: number; url: string }
  | { state: "paid"; amountCents: number }
  | { state: "unavailable" };

const NONE: PublicPayment = { state: "none" };
const UNAVAILABLE: PublicPayment = { state: "unavailable" };

/** A line in the lead's timeline never runs past this (Stripe's own message is capped to the same). */
const REASON_MAX = 200;
/** The same failure is noted at most once in this long, so a client pressing "try again" does not fill the timeline. */
const NOTE_WINDOW_MS = 10 * 60_000;
/** A new invoice is not asked about again until it is this old: the webhook is the normal way to hear of a payment, this is the fallback for one that never came. */
const RECHECK_AFTER_MS = 60_000;

let fetchForTests: Fetch | null = null;
/** Tests only: Stripe is never called for real in a test run, so a test hands in a fake. Null restores the real one. */
export function setStripeFetchForTests(f: Fetch | null): void {
  fetchForTests = f;
}
const fetcher = (deps: { fetch?: Fetch }): Fetch => deps.fetch ?? fetchForTests ?? ((url, init) => fetch(url, init));

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** A reason that is safe to store and show: one line, never the secret key, never longer than the cap. */
function safeReason(e: unknown, key: string | undefined): string {
  const raw = e instanceof Error ? e.message : "unknown error";
  return oneLine(key ? raw.split(key).join("[key]") : raw).slice(0, REASON_MAX);
}

/** How an invoice row reads to the client. A void or uncollectible invoice cannot be paid, and a document has only the one. */
function viewOf(inv: InvoiceRow): PublicPayment {
  if (inv.status === "paid") return { state: "paid", amountCents: inv.amountCents };
  // A draft (never sent) or a row with no link has nothing to pay yet; a void or uncollectible one can no longer be paid.
  if (inv.status === "draft" || inv.status === "void" || inv.status === "uncollectible" || !inv.hostedUrl) return UNAVAILABLE;
  return { state: "open", amountCents: inv.amountCents, url: inv.hostedUrl };
}

async function noteFailure(env: Env, doc: Document, reason: string): Promise<void> {
  const since = new Date(Date.now() - NOTE_WINDOW_MS).toISOString();
  await logActivityOnce(env.DB, doc.businessId, "note", `deposit invoice not created: ${reason}`, since)
    .catch((e) => console.error("deposit: could not log the failure", e instanceof Error ? e.message : "unknown error"));
}

/**
 * Brings an invoice row up to date with Stripe when it is unpaid and old enough, so a webhook that never arrived still resolves: paid (through the same
 * amount and currency check the webhook makes, then `onInvoicePaid`), void or uncollectible. A row that is paid but whose document is not (the first
 * `onInvoicePaid` failed, and the webhook's retry has not come) finishes that work here. Stripe being unreachable is not an error: the row is returned as it is.
 */
async function settle(env: Env, doc: Document, inv: InvoiceRow, f: Fetch): Promise<InvoiceRow> {
  const key = env.STRIPE_SECRET_KEY;
  const stripeInvoiceId = inv.stripeInvoiceId, documentId = inv.documentId;
  if (!stripeInvoiceId || !documentId) return inv; // a deposit made at Stripe has both; a row without them has nothing to settle
  try {
    if (inv.status === "paid") {
      if (!doc.paidAt) await onInvoicePaid(env, inv);
      return inv;
    }
    if (inv.status !== "open" && inv.status !== "failed") return inv;
    if (!key || !stripeMode(key) || Date.now() - Date.parse(inv.createdAt) < RECHECK_AFTER_MS) return inv;
    const s = await retrieveInvoice(f, key, stripeInvoiceId);
    if (s.status === "paid") {
      const problem = paidProblem(inv, { amount_paid: s.amountPaid, currency: s.currency, metadata: { document_id: documentId } });
      if (problem) await markInvoice(env.DB, inv.id, { mismatch: problem }, { notFrom: ["paid", "void"] });
      else {
        await markInvoice(env.DB, inv.id, { status: "paid", paidAt: inv.paidAt ?? new Date().toISOString(), mismatch: null });
        const paid = (await getInvoiceForDocument(env.DB, documentId))!;
        await onInvoicePaid(env, paid);
        return paid;
      }
    } else if (s.status === "void") await markInvoice(env.DB, inv.id, { status: "void" }, { notFrom: ["paid"] });
    else if (s.status === "uncollectible") await markInvoice(env.DB, inv.id, { status: "uncollectible" }, { notFrom: ["paid", "void"] });
  } catch (e) {
    console.error("deposit: could not bring the invoice up to date", safeReason(e, key));
  }
  return (await getInvoiceForDocument(env.DB, documentId)) ?? inv;
}

/**
 * What the client's page shows for a signed document's deposit, without creating anything: the invoice's state (brought up to date with Stripe when it is
 * unpaid and old), or `unavailable` when there is no invoice yet (the page's button asks for one). `none` for a document that is not signed.
 */
export async function paymentFor(env: Env, doc: Document, deps: { fetch?: Fetch } = {}): Promise<PublicPayment> {
  if (doc.status !== "signed") return NONE;
  try {
    const inv = await getInvoiceForDocument(env.DB, doc.id);
    return inv ? viewOf(await settle(env, doc, inv, fetcher(deps))) : UNAVAILABLE;
  } catch (e) {
    console.error("deposit: could not read the payment state", safeReason(e, env.STRIPE_SECRET_KEY));
    return UNAVAILABLE;
  }
}

async function ensure(env: Env, docId: string, deps: { fetch?: Fetch }): Promise<PublicPayment> {
  const doc = await getDocument(env.DB, docId);
  if (!doc || doc.status !== "signed") return NONE;
  const f = fetcher(deps);
  const existing = await getInvoiceForDocument(env.DB, doc.id);
  if (existing) return viewOf(await settle(env, doc, existing, f));

  const key = env.STRIPE_SECRET_KEY;
  const mode = stripeMode(key);
  if (!key || !mode) return UNAVAILABLE; // not set up: the Settings page says so, and there is nothing to retry
  if (mode === "live" && doc.test) {
    await noteFailure(env, doc, "a test copy never makes a live charge");
    return UNAVAILABLE;
  }

  try {
    const h = doc.content.header;
    // Only what the signed document froze goes to Stripe, and the keys are fixed per document and business, so a retry after a half-finished attempt
    // (a draft invoice left at Stripe, a customer made but not saved) replays what Stripe already did instead of making a second one.
    const customerId = (await getStripeCustomer(env.DB, doc.businessId))
      ?? await saveStripeCustomer(env.DB, doc.businessId, (await createCustomer(f, key, { name: h.clientName, email: h.contactEmail, businessId: doc.businessId }, `customer:${doc.businessId}`)).id);
    const made = await createDepositInvoice(f, key, {
      customerId, amountCents: doc.content.schedule.depositCents, description: `${h.clientName} — deposit (${h.reference} v${doc.version})`,
      documentId: doc.id, dealId: doc.dealId, businessId: doc.businessId,
    }, `deposit:${doc.id}`);
    try {
      return viewOf(await insertInvoice(env.DB, {
        businessId: doc.businessId, dealId: doc.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: customerId,
        stripeInvoiceId: made.invoiceId, amountCents: doc.content.schedule.depositCents, hostedUrl: made.hostedUrl,
        ref: `deposit:${doc.id}`, description: "Deposit", test: doc.test, lines: [{ description: "Deposit", amountCents: doc.content.schedule.depositCents }],
      }));
    } catch (e) {
      // Another request for the same document got there first (the same Stripe invoice, by the idempotency key): its row is the one.
      const winner = await getInvoiceForDocument(env.DB, doc.id);
      if (!winner) throw e;
      return viewOf(winner);
    }
  } catch (e) {
    const reason = e instanceof StripeError ? safeReason(e, key) : `could not save it (${safeReason(e, key)})`;
    console.error("deposit: invoice not created", reason);
    await noteFailure(env, doc, reason);
    return UNAVAILABLE;
  }
}

/**
 * Makes the deposit invoice for a signed document, once. Idempotent: an invoice that exists is returned (and, when unpaid and old, checked with Stripe), and
 * a failed attempt can simply be run again. Only the amount the signed document froze (`schedule.depositCents`) is ever charged. It never throws: a failure
 * is a `note` on the lead's timeline and `unavailable`, and no row is left behind. A test copy never creates a live charge.
 */
export async function ensureDepositInvoice(env: Env, docId: string, deps: { fetch?: Fetch } = {}): Promise<PublicPayment> {
  try { return await ensure(env, docId, deps); }
  catch (e) {
    console.error("deposit: unexpected failure", safeReason(e, env.STRIPE_SECRET_KEY));
    return UNAVAILABLE;
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The deal side of a deposit that has been paid, for a real (not test) proposal. A signed and paid real proposal is the strongest sign the deal is won, so a
 * deal at ANY open stage is won: outreach stops, the `deal_moved` marker is written, the deal moves, and only then does the lead become won (so "lead won,
 * deal lost" cannot arise). The marker goes first so a second run of the same payment, seeing the deal already won, can tell it was this payment and is not
 * a deal won some other way; the lead step is repeated by every run until it holds. A deal that is lost, or won by something else, is left alone and noted.
 */
async function winDeal(env: Env, doc: Document): Promise<void> {
  const db = env.DB;
  const deal = await getDeal(db, doc.dealId);
  if (!deal) return;
  const tail = ` -> won (deposit paid, ${doc.content.header.reference} v${doc.version})`;
  const check = (stage: string) => logActivityOnce(db, doc.businessId, "note", `deposit paid but the deal is ${stage}: check it`);
  const marked = async () => !!(await db.prepare(`SELECT 1 AS x FROM activity WHERE business_id = ? AND kind = 'deal_moved' AND instr(detail, ?) > 0 LIMIT 1`).bind(doc.businessId, tail).first());
  const leadWon = async () => {
    const lead = await getBusiness(db, doc.businessId);
    if (lead && lead.lead_status !== "won") {
      await updateLead(db, doc.businessId, { leadStatus: "won" });
      await logActivity(db, doc.businessId, "status", `${lead.lead_status} → won`);
    }
  };

  if (deal.stage === "lost") { await check("lost"); return; }
  if (deal.stage === "won") {
    // Won by this very payment (an earlier run, or the webhook and the page at once) is finished here; anything else is for the owner to look at.
    if (await marked()) await leadWon(); else await check("won");
    return;
  }
  await stopOutreach(db, { businessId: doc.businessId, reason: "manual" });
  await logActivityOnce(db, doc.businessId, "deal_moved", `${deal.stage}${tail}`);
  try { await moveDeal(db, deal.id, "won"); }
  catch (e) {
    if (!(e instanceof DealMoveError)) throw e;
    // It moved between our read and our write: by a parallel run of this very payment (the lead step below is then still ours to finish) or by the owner (lost).
    const now = await getDeal(db, deal.id);
    if (now && now.stage !== "won") { await check(now.stage); return; }
  }
  await leadWon();
}

/**
 * The production `onPaid`, run when a deposit invoice is paid (by the webhook, or found paid by the page). It can run more than once for one payment (the
 * webhook retries an event whose handling failed, and the page can find the payment too), so every step is safe to repeat. The document is marked paid last:
 * a document with a paid time has had all of this done. A test copy is marked paid and nothing else; a real one also wins its deal and starts its onboarding and its projects.
 */
export async function onInvoicePaid(env: Env, inv: InvoiceRow): Promise<void> {
  if (!inv.documentId) { console.error("deposit: a paid invoice has no document", inv.id); return; }
  const doc = await getDocument(env.DB, inv.documentId);
  if (!doc) { console.error("deposit: a paid invoice has no document", inv.id); return; }
  await logActivityOnce(env.DB, doc.businessId, "deposit_paid", `Deposit ${dollars(inv.amountCents)} paid (${doc.content.header.reference} v${doc.version})${doc.test ? ", test copy" : ""}`);
  if (!doc.test) {
    await winDeal(env, doc);
    // The welcome is put up for Logan's approval; a failure here is noted on the lead and must never stop the payment from being recorded.
    try { await startOnboarding(env, doc); }
    catch (e) { console.error("deposit: onboarding was not started", safeReason(e, env.STRIPE_SECRET_KEY)); }
    // The projects come from the same signed document. Their own try: a failure here neither stops the payment nor the onboarding that has already started.
    try { await startProjects(env, doc); }
    catch (e) {
      const reason = safeReason(e, env.STRIPE_SECRET_KEY);
      console.error("deposit: projects were not started", reason);
      // The payment is recorded below and never replayed, so Logan must be told on the lead's timeline, where the next step is. Its own try: a note that cannot be written changes nothing.
      try {
        await logActivityOnce(env.DB, doc.businessId, "note", `${doc.content.header.reference} v${doc.version}: projects were not started: ${reason}. Use Start projects on the deal, or wait for the daily sweep.`);
      } catch (e2) { console.error("deposit: could not note that projects were not started", safeReason(e2, env.STRIPE_SECRET_KEY)); }
    }
  }
  await setPaid(env.DB, doc.id, inv.paidAt ?? new Date().toISOString());
}
