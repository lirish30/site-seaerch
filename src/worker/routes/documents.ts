import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSendApproval } from "../approvals/proposalSend";
import { logActivity } from "../db/activity";
import { lastBookingFor } from "../db/bookings";
import { getDeal } from "../db/deals";
import { DocumentStateError, countViews, getDocument, listForDeal, signaturesFor, type Document } from "../db/documents";
import { getInvoiceForDocument } from "../db/invoices";
import { getSettings } from "../db/settings";
import { legalGate, parseDocumentsConfig, showDraftBanner } from "../documents/config";
import { ensureDepositInvoice } from "../documents/deposit";
import { clientBase } from "../documents/mail";
import { ProposalError } from "../documents/proposal";
import { PROPOSAL_CSP, renderProposalHtml } from "../documents/render";
import { signedPdfResponse } from "../documents/signed";
import { stripeMode } from "../stripe/client";
import { draftProposal, editDraft, sendProblems, sendTest, voidProposal } from "../documents/service";

const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

/** The caps hold twice: here (a 400 that names the field) and in the proposal's own schema (which the proposal is checked against whatever calls it). */
const Edits = z.object({
  scopeNotes: z.string().max(4000).optional(),
  extraAssumptions: z.array(z.string().max(300)).max(20).optional(),
  extraOutOfScope: z.array(z.string().max(300)).max(20).optional(),
  careDeclined: z.boolean().optional(),
}).strict();
const Contact = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().pipe(z.email().max(254)) }).strict();
const DraftBody = z.object({ optionId: z.enum(["a", "b", "c"]), edits: Edits.default({}), contact: Contact.optional(), test: z.boolean().optional() }).strict();
const EditBody = z.object({ edits: Edits }).strict();
const VoidBody = z.object({ reason: z.string().trim().min(1).max(300) }).strict();

/** The states a deal's proposal is in: one of these is the one the owner is working with (the rest are history). */
const WORKING: Document["status"][] = ["draft", "sent", "viewed", "signed"];

/** A conflict with the document's state is a 409; a proposal that cannot be built is a 422 with the reason. */
function failure(c: { json: (body: unknown, status: 409 | 422) => Response }, e: unknown): Response {
  if (e instanceof DocumentStateError) return c.json({ error: e.message }, 409);
  if (e instanceof ProposalError) return c.json({ error: e.message }, 422);
  throw e;
}

/** Mounted at /api: /deals/:id/proposal and /documents/:id/... (all behind requireAuth). */
export const documentRoutes = new Hono<{ Bindings: Env }>();

/** What the Documents settings page shows about billing: the Stripe mode and whether the webhook secret is set (never a secret) and where client links point. */
documentRoutes.get("/documents/config", (c) =>
  c.json({ stripeMode: stripeMode(c.env.STRIPE_SECRET_KEY), webhookConfigured: !!c.env.STRIPE_WEBHOOK_SECRET, clientBase: clientBase(c.env) }));

documentRoutes.get("/deals/:id/proposal", async (c) => {
  const deal = await getDeal(c.env.DB, c.req.param("id"));
  if (!deal) return c.json({ error: "not found" }, 404);
  const [history, settings, booking] = await Promise.all([listForDeal(c.env.DB, deal.id), getSettings(c.env.DB), lastBookingFor(c.env.DB, deal.businessId, "discovery")]);
  const current = history.find((d) => WORKING.includes(d.status)) ?? null;
  return c.json({
    current, history,
    // The current document's deposit invoice, once it has one (the Deal tab shows its state, and a retry when there is none).
    invoice: current ? await getInvoiceForDocument(c.env.DB, current.id) : null,
    // How many times the client opened the current proposal (the "Viewed" line on the timeline).
    views: current ? await countViews(c.env.DB, current.id) : 0,
    legalGate: legalGate(parseDocumentsConfig(settings.documents_config)), clientBase: clientBase(c.env),
    // Who the proposal goes to when the form leaves the contact blank: the person who booked the discovery call.
    defaultContact: booking ? { name: booking.contactName, email: booking.contactEmail } : null,
  });
});

documentRoutes.post("/deals/:id/proposal", async (c) => {
  const parsed = DraftBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  if (!(await getDeal(c.env.DB, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  try { return c.json(await draftProposal(c.env, c.req.param("id"), parsed.data), 201); }
  catch (e) { return failure(c, e); }
});

documentRoutes.put("/documents/:id", async (c) => {
  const parsed = EditBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  try { return c.json(await editDraft(c.env, doc, parsed.data.edits)); }
  catch (e) { return failure(c, e); }
});

/** The proposal as the client would see it, for the owner's iframe. Nothing runs in it and only this app may frame it. */
documentRoutes.get("/documents/:id/preview.html", async (c) => {
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  const [signatures, settings] = await Promise.all([signaturesFor(c.env.DB, doc.id), getSettings(c.env.DB)]);
  const html = renderProposalHtml(doc.content, {
    mode: "screen", status: doc.status, contentSha256: doc.contentSha256, signatures, auditPage: doc.status === "signed",
    draftBanner: showDraftBanner(doc, legalGate(parseDocumentsConfig(settings.documents_config))),
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PROPOSAL_CSP, "cache-control": "no-store" } });
});

/** The owner's copy of the signed PDF (made now if signing did not make it). A document that is not signed has none: 409. */
documentRoutes.get("/documents/:id/pdf", async (c) => {
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  return doc ? signedPdfResponse(c.env, doc) : c.json({ error: "not found" }, 404);
});

/** Puts the draft up for the owner's approval (which is his countersignature). Nothing is mailed until he approves it. */
documentRoutes.post("/documents/:id/send", async (c) => {
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  const problems = await sendProblems(c.env, doc);
  if (problems.length > 0) return c.json({ error: problems[0], approvalId: null, problems }, 409);
  const a = await createSendApproval(c.env, doc);
  return c.json({ approvalId: a.id, problems });
});

/** Sends the real link to the owner's own address, as a test copy: no approval, no review needed, the deal stays where it is. */
documentRoutes.post("/documents/:id/test-send", async (c) => {
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  try { return c.json(await sendTest(c.env, doc)); }
  catch (e) {
    if (e instanceof DocumentStateError) return failure(c, e);
    console.error("proposal test send failed", e instanceof Error ? e.message : "unknown error");
    return c.json({ error: `The test copy was made but the email did not go: ${e instanceof Error ? e.message : "unknown error"}` }, 502);
  }
});

/** The owner's retry for a deposit invoice that could not be made: the same idempotent call the client's pay button makes. Only a signed proposal has a deposit. */
documentRoutes.post("/documents/:id/deposit", async (c) => {
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  if (doc.status !== "signed") return c.json({ error: "only a signed proposal has a deposit" }, 409);
  return c.json(await ensureDepositInvoice(c.env, doc.id));
});

documentRoutes.post("/documents/:id/void", async (c) => {
  const parsed = VoidBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const doc = await getDocument(c.env.DB, c.req.param("id"));
  if (!doc) return c.json({ error: "not found" }, 404);
  try {
    const voided = await voidProposal(c.env.DB, doc, parsed.data.reason);
    if (doc.status !== "void") await logActivity(c.env.DB, doc.businessId, "proposal_void", `${doc.content.header.reference} v${doc.version}: ${parsed.data.reason}`);
    return c.json(voided);
  } catch (e) { return failure(c, e); }
});
