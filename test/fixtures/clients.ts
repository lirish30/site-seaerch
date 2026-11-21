import { env } from "cloudflare:test";
import { createChangeOrderDraft } from "../../src/worker/db/changeOrders";
import type { PackageKey } from "../../src/worker/db/packages";
import { createPerson } from "../../src/worker/db/people";
import { createProject } from "../../src/worker/db/projects";
import { createSite } from "../../src/worker/db/sites";
import { insertPlanned, markSubscription, type SubscriptionStatus } from "../../src/worker/db/subscriptions";
import { openInvoice, seedDraft } from "./billing";
import { proposal, seedDeal } from "./documents";
import { T0 } from "./projects";

export type SubSpec = { key?: PackageKey; monthlyCents: number; status?: SubscriptionStatus; test?: boolean; termEndsOn?: string | null };

/**
 * A signed document row for the deal, written directly: a deal holds only one open proposal at a time, and a project, an invoice and each subscription need a document of their own to hang
 * off (the next `createDraft` on the deal would delete a draft one).
 */
async function signedDocument(s: { businessId: string; dealId: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const version = ((await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM documents WHERE deal_id = ?`).bind(s.dealId).first<{ v: number }>())!.v) + 1;
  await env.DB.prepare(
    `INSERT INTO documents (id, deal_id, business_id, version, status, test, option_id, content, sent_at, signed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'signed', 0, 'b', ?, ?, ?, ?, ?)`,
  ).bind(id, s.dealId, s.businessId, version, JSON.stringify(proposal()), T0, T0, T0, T0).run();
  return { id };
}

/** One subscription on a business, planned from its own draft document (a document holds one row per package) and then moved to `status`. */
export async function addSub(s: { businessId: string; dealId: string }, o: SubSpec) {
  const doc = await signedDocument(s);
  const { subscription } = await insertPlanned(env.DB, {
    businessId: s.businessId, documentId: doc.id, projectId: null, packageKey: o.key ?? "website_subscription", packageVersion: 1, monthlyCents: o.monthlyCents,
    startsWhen: "signing", firstChargeOn: null, termMonths: o.termEndsOn ? 24 : null, termEndsOn: o.termEndsOn ?? null, endAction: "none", test: o.test ?? false,
  });
  const status = o.status ?? "active";
  if (status !== "planned") await markSubscription(env.DB, subscription.id, { status }, { from: ["planned"] });
  return subscription.id;
}

/**
 * A client: a won business with a point of contact, one site (six `needed` access items), a real build project, and the subscriptions given (none by default).
 * `won: false` leaves the lead status alone (a lead that only has a project); `project: false` leaves the project out; `invoice` gives it one open invoice of that many cents.
 */
export async function seedClient(o: { won?: boolean; project?: boolean; site?: boolean; test?: boolean; subs?: SubSpec[]; invoice?: { cents: number; dueOn?: string } } = {}) {
  const s = await seedDeal();
  if (o.won !== false) await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(s.businessId).run();
  const person = await createPerson(env.DB, s.businessId, { name: "Pat Jones", role: "Owner", email: "pat@ace.test", phone: "208-555-0100", is_poc: true });
  const site = o.site === false ? null : (await createSite(env.DB, { businessId: s.businessId, url: "https://ace.com", test: o.test ?? false })).site;
  const doc = await signedDocument(s);
  const project = o.project === false ? null : (await createProject(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, onboardingId: null, kind: "build", name: "Website build", test: o.test ?? false,
    templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: T0,
  })).project;
  const subIds: string[] = [];
  for (const sub of o.subs ?? []) subIds.push(await addSub(s, { ...sub, test: sub.test ?? o.test ?? false }));
  let invoice = null;
  if (o.invoice) {
    const draft = await seedDraft({ seed: { ...s, documentId: doc.id }, lines: [{ description: "Deposit", amountCents: o.invoice.cents }], test: o.test ?? false });
    invoice = await openInvoice(draft.invoice);
    if (o.invoice.dueOn) await env.DB.prepare(`UPDATE invoices SET due_on = ? WHERE id = ?`).bind(o.invoice.dueOn, invoice.id).run();
  }
  return { ...s, person, site, project, subIds, invoice, documentId: doc.id };
}

/** A change order on a project, made by hand; the project can be in any state. */
export async function addChangeOrder(s: { businessId: string; dealId: string | null }, projectId: string) {
  const { changeOrder } = await createChangeOrderDraft(env.DB, {
    projectId, businessId: s.businessId, dealId: s.dealId, test: false, sourceType: "logan", originApprovalId: null, referenceBase: "SL-ACE",
    content: {
      title: "Add a gallery", summary: "A photo gallery page.", reason: "The client asked for it.", deliverables: ["Gallery page"], notIncluded: [], hours: 2, rateCents: 15000, priceCents: 30000,
      scheduleImpactDays: null, clientName: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@ace.test",
    },
  });
  return changeOrder;
}
