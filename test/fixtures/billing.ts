import { env } from "cloudflare:test";
import { expect } from "vitest";
import { createDraft, setPaid, signDocument } from "../../src/worker/db/documents";
import { attachStripeInvoice, getInvoice, insertDraftInvoice, type InvoiceKind, type InvoiceLine, type InvoiceRow } from "../../src/worker/db/invoices";
import { listCurrentPackages, snapshotOf } from "../../src/worker/db/packages";
import { createProject } from "../../src/worker/db/projects";
import { paymentSchedule } from "../../src/worker/documents/schedule";
import { PROPOSAL_OPTIONS, clientSig, proposal, seedDeal, sendDraft } from "./documents";
import { invoiceEvent } from "./stripe";

/** A deal with a draft proposal: what a draft invoice hangs off. */
export async function seedDoc() {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  return { ...s, documentId: doc.id };
}

type Seed = Awaited<ReturnType<typeof seedDoc>>;

/** A draft invoice (no Stripe object) on a seeded document; `ref` defaults to a fresh one. */
export async function seedDraft(o: { seed?: Seed; kind?: InvoiceKind; ref?: string; lines?: InvoiceLine[]; test?: boolean } = {}) {
  const s = o.seed ?? await seedDoc();
  const { invoice, created } = await insertDraftInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, changeOrderId: null, subscriptionId: null,
    kind: o.kind ?? "milestone", ref: o.ref ?? `milestone:${crypto.randomUUID()}`, test: o.test ?? false, description: "Milestone",
    lines: o.lines ?? [{ description: "Design approved", amountCents: 100000 }],
  });
  return { ...s, invoice, created };
}

// ---- Task 3: a project started from a signed and paid proposal ----

const SIGNED_AT = "2026-12-02T09:00:00.000Z";
const FAR = "2099-01-01T00:00:00.000Z";

/**
 * A real project started from a document that was sent, signed and paid, with the payment schedule the catalog gives for the option ("b" Starter with Care, "c" Growth with Care).
 * `test` marks the project (and its document) a test copy.
 */
export async function seedSignedProject(o: { option?: "b" | "c"; test?: boolean; paid?: boolean; signed?: boolean } = {}) {
  const s = await seedDeal();
  const packages = (await listCurrentPackages(env.DB)).map(snapshotOf);
  const option = PROPOSAL_OPTIONS.find((p) => p.id === (o.option ?? "b"))!;
  const content = { ...proposal(), optionId: option.id, schedule: paymentSchedule(option, packages) };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: option.id, content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  if (o.signed !== false) expect(await signDocument(env.DB, doc.id, clientSig(hash), SIGNED_AT)).toBe("signed");
  if (o.paid !== false) await setPaid(env.DB, doc.id, SIGNED_AT);
  const { project } = await createProject(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, onboardingId: null, kind: "build", name: "Ace Plumbing: Website build", test: o.test ?? false,
    templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: SIGNED_AT,
  });
  return { ...s, documentId: doc.id, project, schedule: content.schedule };
}

// ---- Task 4: invoices that exist at Stripe, and the events about them ----

/** A draft made open the way an approved send does: Stripe ids, a link and a due date attached. */
export async function openInvoice(draft: InvoiceRow): Promise<InvoiceRow> {
  const stripeInvoiceId = `in_${crypto.randomUUID().slice(0, 8)}`;
  expect(await attachStripeInvoice(env.DB, draft.id, { stripeCustomerId: "cus_1", stripeInvoiceId, hostedUrl: "https://invoice.stripe.com/i/x", dueOn: "2027-01-20", now: "2026-12-20T10:00:00.000Z" })).toBe(true);
  return (await getInvoice(env.DB, draft.id))!;
}

/** An invoice.* event for a billing invoice: Stripe echoes back the metadata we set (ref, kind, document). */
export function refEvent(type: string, inv: InvoiceRow, object: Record<string, unknown> = {}) {
  return invoiceEvent(type, inv, { object: { metadata: { ref: inv.ref, kind: inv.kind, document_id: inv.documentId ?? undefined }, ...object } });
}
