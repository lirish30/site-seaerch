import { env } from "cloudflare:test";
import { expect } from "vitest";
import { createDraft, getDocument, setPaid, signDocument } from "../../src/worker/db/documents";
import { attachStripeInvoice, getInvoice, insertDraftInvoice, type InvoiceKind, type InvoiceLine, type InvoiceRow } from "../../src/worker/db/invoices";
import { listCurrentPackages, snapshotOf, type PackageKey } from "../../src/worker/db/packages";
import { createApproval } from "../../src/worker/db/approvals";
import { insertOutbound, markSent } from "../../src/worker/db/messages";
import { placeHold } from "../../src/worker/db/holds";
import { createProject } from "../../src/worker/db/projects";
import { ensureSeedSops } from "../../src/worker/db/sops";
import { insertTasks } from "../../src/worker/db/tasks";
import { paymentSchedule } from "../../src/worker/documents/schedule";
import type { Option } from "../../src/worker/sales/options";
import { PROPOSAL_OPTIONS, clientSig, proposal, seedDeal, sendDraft } from "./documents";
import { planSubscriptions } from "../../src/worker/billing/subscriptions";
import { getSubscription, listSubscriptions, markSubscription } from "../../src/worker/db/subscriptions";
import { newTask, seedProject } from "./projects";
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

// ---- Task 6: signed documents that sell a subscription ----

/**
 * A signed document selling exactly these packages (the payment schedule is the catalog's own), paid at `paidAt` unless `paid` is false, with its build project (active) when `build` is set.
 * `test` makes the document a test copy. The subscriptions are NOT planned: a test calls `planSubscriptions` (or `insertPlanned`) itself.
 */
export async function seedSubscriptionDoc(o: { keys: PackageKey[]; test?: boolean; paid?: boolean; paidAt?: string; build?: boolean }) {
  const s = await seedDeal();
  const catalog = await listCurrentPackages(env.DB);
  const option: Option = { id: "b", label: "Plan", tagline: "", items: o.keys.map((key) => ({ key })), recommended: true };
  const schedule = paymentSchedule(option, catalog.map(snapshotOf));
  const packages = o.keys.map((key) => { const p = catalog.find((c) => c.key === key)!; return { key, version: p.version, name: p.name, priceLine: "", includes: [] as string[] }; });
  const content = { ...proposal(), optionId: "b" as const, packages, schedule };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  expect(await signDocument(env.DB, doc.id, clientSig(hash), SIGNED_AT)).toBe("signed");
  if (o.paid !== false) await setPaid(env.DB, doc.id, o.paidAt ?? SIGNED_AT);
  const project = o.build
    ? (await createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: doc.id, onboardingId: null, kind: "build", name: "Ace Plumbing: Website build", test: o.test ?? false,
      templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: SIGNED_AT,
    })).project
    : null;
  return { ...s, documentId: doc.id, project, schedule };
}

// ---- Task 10: a client whose invoice holds its work, with a Claude step waiting on the hold ----

/**
 * Puts the projects of earlier tests out of the way (cancelled, not deleted: an invoice may hang off one) and makes the SOP templates active, so `dispatchReady` has something real to send and the
 * sweeps see only this test's clients. Every open hold is lifted.
 */
export async function prepareDispatch() {
  await env.DB.prepare(`UPDATE projects SET status = 'cancelled' WHERE status != 'cancelled'`).run();
  await ensureSeedSops(env.DB);
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
  await env.DB.prepare(`UPDATE billing_holds SET lifted_at = '2026-01-01T00:00:00.000Z', lifted_by = 'manual' WHERE lifted_at IS NULL`).run();
}

/** A real client with an active project holding one Claude step, an open invoice and the hold it placed. Until the hold is lifted and `dispatchReady` runs, the step stays `todo`. */
export async function heldClient() {
  const s = await seedProject();
  const [step] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "a", owner: "claude", title: "Write the homepage draft" })]);
  const draft = await seedDraft({ seed: s as NonNullable<NonNullable<Parameters<typeof seedDraft>[0]>["seed"]> });
  const invoice = await openInvoice(draft.invoice);
  expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: invoice.id, now: "2027-02-03T18:00:00.000Z" })).toBe(true);
  return { ...s, step, invoice };
}

/** The signed document for these packages with its subscriptions planned (newest row last), as the signing step leaves them. */
export async function plannedSubs(keys: PackageKey[], o: { test?: boolean; paid?: boolean; build?: boolean } = {}) {
  const s = await seedSubscriptionDoc({ keys, ...o });
  const doc = (await getDocument(env.DB, s.documentId))!;
  await planSubscriptions(env as never, doc);
  const subs = (await listSubscriptions(env.DB, { businessId: s.businessId })).reverse();
  return { ...s, doc, subs };
}

/** An active, real subscription for a fresh client with a Stripe subscription id (Website Subscription by default) and its term end. */
export async function activeSub(o: { keys?: PackageKey[]; termEndsOn?: string | null; status?: "active" | "past_due" } = {}) {
  const s = await plannedSubs(o.keys ?? ["website_subscription"]);
  expect(await markSubscription(env.DB, s.subs[0].id, {
    status: o.status ?? "active", termEndsOn: o.termEndsOn === undefined ? "2028-12-20" : o.termEndsOn, activatedAt: "2026-12-20T10:00:00.000Z",
    stripeSubscriptionId: `sub_${crypto.randomUUID().slice(0, 8)}`, stripeCustomerId: "cus_1",
  }, { from: ["planned"] })).toBe(true);
  return { ...s, sub: (await getSubscription(env.DB, s.subs[0].id))! };
}

type SeedArg = NonNullable<NonNullable<Parameters<typeof seedDraft>[0]>["seed"]>;
/**
 * A real milestone invoice for a client, sent the way the send approval leaves it (open, with a link, due `dueOn`) and whose `invoice.send` mail really went out, so reminders and the hold count it.
 * `mailed: false` leaves the mail unsent.
 */
export async function sentInvoice(s: { businessId: string; dealId: string; documentId: string | null }, o: { dueOn?: string; mailed?: boolean } = {}) {
  const d = await seedDraft({ seed: s as SeedArg });
  expect(await attachStripeInvoice(env.DB, d.invoice.id, {
    stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: "https://invoice.stripe.com/i/abc", dueOn: o.dueOn ?? "2027-01-20", now: "2027-01-13T10:00:00.000Z",
  })).toBe(true);
  const invoice = (await getInvoice(env.DB, d.invoice.id))!;
  const a = await createApproval(env.DB, { kind: "invoice.send", title: "Send invoice", preview: "", payload: { invoiceId: invoice.id }, record_type: "business", record_id: invoice.businessId, drafted_by: "logan" });
  await env.DB.prepare(`UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?`).bind("2027-01-13T10:00:00.000Z", a.id).run();
  if (o.mailed !== false) {
    const id = crypto.randomUUID();
    expect(await insertOutbound(env.DB, id, { mailbox: "main", businessId: invoice.businessId, enrollmentId: null, stepIndex: null, approvalId: a.id, messageId: `<${id}@x>`, inReplyTo: null, to: "pat@ace.test", subject: "Invoice", text: "x", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
    await markSent(env.DB, id, "2027-01-13T10:00:01.000Z");
  }
  return invoice;
}
