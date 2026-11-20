import { Hono } from "hono";
import { z } from "zod";
import { reminderBase } from "../approvals/invoiceReminder";
import { invoiceChangeOrder } from "../billing/changeOrderInvoice";
import { calendarDateIn } from "../billing/dates";
import { discardInvoice, voidSentInvoice } from "../billing/discard";
import { proposeInvoice } from "../billing/draft";
import { hourlyInvoice } from "../billing/hourly";
import { liftManually } from "../billing/hold";
import { startKickoff } from "../billing/subscriptions";
import { EarlyExitError, cancelSubscription, setEndAction } from "../billing/terms";
import { getChangeOrder } from "../db/changeOrders";
import { activeHolds, getHold } from "../db/holds";
import { INVOICE_KINDS, getInvoice, listInvoices, type InvoiceRow } from "../db/invoices";
import { getProject } from "../db/projects";
import { getSettings } from "../db/settings";
import { SUBSCRIPTION_STATUSES, getSubscription, listSubscriptions, sumActiveMonthlyCents, type Subscription } from "../db/subscriptions";
import { parseDocumentsConfig, legalGate } from "../documents/config";
import { clientBase } from "../documents/mail";
import type { Env } from "../env";
import { bodyOf, invalid, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { zoneOf } from "../sop/cadence";
import { StripeError, stripeMode } from "../stripe/client";

/**
 * Mounted at /api (behind requireAuth): /billing/..., /change-orders/:id/invoice and /projects/:id/invoices/hourly. Nothing here mails a client or makes anything at Stripe by itself: an invoice is put up
 * for approval, and what Stripe is asked to do (void, cancel) is Logan's own action. The Stripe key and webhook secret are never returned.
 */
export const billingRoutes = new Hono<{ Bindings: Env }>();
billingRoutes.onError(ownerOnError);

const NoBody = z.object({}).strict();
const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible", "failed"] as const;
const InvoiceQuery = z.object({
  status: z.enum(INVOICE_STATUSES).optional(), kind: z.enum(INVOICE_KINDS).optional(), businessId: z.string().min(1).max(100).optional(), projectId: z.string().min(1).max(100).optional(),
}).strict();
const SubscriptionQuery = z.object({ status: z.enum(SUBSCRIPTION_STATUSES).optional() }).strict();
const EndActionBody = z.object({ endAction: z.enum(["convert_to_care", "none"]) }).strict();
const CancelBody = z.object({ confirmEarlyExit: z.boolean().optional() }).strict();

/** The query string as a plain object, parsed with `schema`, or the 400 to send back. */
function queryOf<S extends z.ZodType>(c: Ctx, schema: S): z.infer<S> | Response {
  const parsed = schema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  return parsed.success ? parsed.data : c.json(invalid(parsed.error), 400);
}

/**
 * A refusal the billing services make is a plain sentence the owner can act on ("This invoice is paid, so it cannot be voided."): it is answered 409 with that sentence, and a Stripe failure is
 * answered 502 with Stripe's own (capped, key-free) message. A database error or a bug is not one of these (it is not a bare Error, or it carries the driver's name): it is rethrown, so
 * `ownerOnError` logs it and sends the fixed sentence.
 */
async function guarded(c: Ctx, run: () => Promise<Response>): Promise<Response> {
  try { return await run(); }
  catch (e) {
    if (e instanceof EarlyExitError) return c.json({ error: e.message, earlyExitCents: e.cents }, 409);
    if (e instanceof StripeError) return c.json({ error: `Stripe said: ${e.message}` }, 502);
    if (e instanceof Error && e.constructor === Error && !/D1_|SQLITE/i.test(e.message)) return c.json({ error: e.message }, 409);
    throw e;
  }
}

/** An approval as the owner's pages need it. */
const approvalOf = (a: { id: string; kind: string; title: string; status: string } | null) => (a ? { id: a.id, kind: a.kind, title: a.title, status: a.status } : null);

/** A subscription without the token of the client's link (a secret that lives in the approval and the mail, not in a list). */
const subscriptionOf = ({ token: _token, ...rest }: Subscription) => rest;

const SUM = (rows: InvoiceRow[]) => rows.reduce((n, i) => n + i.amountCents, 0);

// ---- the overview ----

/** MRR from the active and past-due subscriptions; what is open (sent and unpaid) and what is overdue, in real invoices only; and how many clients have an open hold. */
billingRoutes.get("/billing/summary", async (c) => {
  const db = c.env.DB;
  const today = calendarDateIn(new Date(), zoneOf(await getSettings(db)));
  const unpaid = (await listInvoices(db, { statuses: ["open", "failed"] })).filter((i) => !i.test);
  const overdue = unpaid.filter((i) => { const base = reminderBase(i); return base !== null && base < today; });
  const held = await db.prepare(`SELECT COUNT(DISTINCT business_id) AS n FROM billing_holds WHERE lifted_at IS NULL`).first<{ n: number }>();
  return c.json({ mrrCents: await sumActiveMonthlyCents(db), openCents: SUM(unpaid), overdueCents: SUM(overdue), heldClients: held?.n ?? 0 });
});

// ---- invoices ----

billingRoutes.get("/billing/invoices", async (c) => {
  const q = queryOf(c, InvoiceQuery);
  if (q instanceof Response) return q;
  const invoices = await listInvoices(c.env.DB, {
    ...(q.status ? { statuses: [q.status] } : {}), ...(q.kind ? { kinds: [q.kind] } : {}), ...(q.businessId ? { businessId: q.businessId } : {}), ...(q.projectId ? { projectId: q.projectId } : {}),
  });
  return c.json({ invoices });
});

/** Puts a draft up for approval (the one waiting approval, or a new one when the earlier one was rejected). Anything that is not a draft is 409. */
billingRoutes.post("/billing/invoices/:id/propose", async (c) => {
  const inv = await getInvoice(c.env.DB, c.req.param("id"));
  if (!inv) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => c.json({ approval: approvalOf(await proposeInvoice(c.env, inv.id)) }));
});

/** Throws a draft away (it was never sent: no Stripe object exists). A sent invoice is voided instead, and a paid one is neither: 409. */
billingRoutes.post("/billing/invoices/:id/discard", async (c) => {
  if (!(await getInvoice(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => c.json({ invoice: await discardInvoice(c.env, c.req.param("id")) }));
});

/** Cancels an invoice that was sent and not paid: Stripe voids it, its hold lifts, its time is released. */
billingRoutes.post("/billing/invoices/:id/void", async (c) => {
  if (!(await getInvoice(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => c.json({ invoice: await voidSentInvoice(c.env, c.req.param("id")) }));
});

/** Drafts the invoice of a signed change order and puts it up for approval. One whose invoice was voided is not made again: 409. */
billingRoutes.post("/change-orders/:id/invoice", async (c) => {
  if (!(await getChangeOrder(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => {
    const { invoice, approval } = await invoiceChangeOrder(c.env, c.req.param("id"));
    if (invoice.status === "void") return c.json({ error: "The invoice for this change order was voided, so it is not made again." }, 409);
    return c.json({ invoice, approval: approvalOf(approval) });
  });
});

/** Invoices all the finished billable time on a project that is not on an invoice yet, and puts it up for approval. Nothing to bill is 409. */
billingRoutes.post("/projects/:id/invoices/hourly", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => {
    const made = await hourlyInvoice(c.env, { projectId: project.id, now: new Date() });
    if (!made) return c.json({ error: "There is no finished billable time on this project that is not on an invoice yet, so there is nothing to invoice." }, 409);
    return c.json({ invoice: made.invoice, approval: approvalOf(made.approval) }, 201);
  });
});

// ---- subscriptions ----

billingRoutes.get("/billing/subscriptions", async (c) => {
  const q = queryOf(c, SubscriptionQuery);
  if (q instanceof Response) return q;
  return c.json({ subscriptions: (await listSubscriptions(c.env.DB, q.status ? { statuses: [q.status] } : {})).map(subscriptionOf) });
});

/** Logan's "Start billing" for a subscription that starts at kickoff: puts it up for approval. */
billingRoutes.post("/billing/subscriptions/:id/start", async (c) => {
  if (!(await getSubscription(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => c.json({ approval: approvalOf(await startKickoff(c.env, c.req.param("id"), new Date())) }));
});

/** What happens at the end of the term: move to Care, or nothing. */
billingRoutes.patch("/billing/subscriptions/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getSubscription(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, EndActionBody);
  if (body instanceof Response) return body;
  if (!(await setEndAction(c.env.DB, id, body.endAction))) return c.json({ error: "This subscription is already over, so its end action cannot change." }, 409);
  return c.json({ subscription: subscriptionOf((await getSubscription(c.env.DB, id))!) });
});

/** Cancels a subscription. A balance for leaving early is 409 with its amount until `confirmEarlyExit` is true. */
billingRoutes.post("/billing/subscriptions/:id/cancel", async (c) => {
  if (!(await getSubscription(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, CancelBody);
  if (body instanceof Response) return body;
  return guarded(c, async () => {
    const out = await cancelSubscription(c.env, c.req.param("id"), { confirmEarlyExit: body.confirmEarlyExit === true, now: new Date() });
    return c.json({ subscription: subscriptionOf(out.subscription), invoice: out.invoice });
  });
});

// ---- holds ----

billingRoutes.get("/billing/holds", async (c) => c.json({ holds: await activeHolds(c.env.DB) }));

/** Logan lifts a hold by hand: the waiting Claude steps are sent at once. A hold that is already lifted is 409. */
billingRoutes.post("/billing/holds/:id/lift", async (c) => {
  const hold = await getHold(c.env.DB, c.req.param("id"));
  if (!hold) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, NoBody);
  if (body instanceof Response) return body;
  if (hold.liftedAt) return c.json({ error: "This hold is already lifted." }, 409);
  await liftManually(c.env, hold.id, new Date());
  return c.json({ ok: true });
});

// ---- setup ----

/** What is set up, as booleans and a mode: never a key or a secret. */
billingRoutes.get("/billing/stripe-status", async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({
    mode: stripeMode(c.env.STRIPE_SECRET_KEY), webhookSecretSet: !!c.env.STRIPE_WEBHOOK_SECRET, clientBaseSet: !!clientBase(c.env),
    legalReviewed: legalGate(parseDocumentsConfig(settings.documents_config)) === null,
  });
});
