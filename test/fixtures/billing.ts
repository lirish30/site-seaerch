import { env } from "cloudflare:test";
import { createDraft } from "../../src/worker/db/documents";
import { insertDraftInvoice, type InvoiceKind, type InvoiceLine } from "../../src/worker/db/invoices";
import { proposal, seedDeal } from "./documents";

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
