import { dollars } from "../../client/packagesView";
import type { Approval } from "../db/approvals";
import { insertDraftInvoiceClaimingTime, listInvoices, type InvoiceRow } from "../db/invoices";
import { getPackage } from "../db/packages";
import { getProject } from "../db/projects";
import { listSubscriptions } from "../db/subscriptions";
import { unbilledBillableMinutes } from "../db/time";
import type { Env } from "../env";
import { proposeInvoice } from "./draft";

/** Billable time is invoiced in blocks of this many minutes, rounded up in total. */
export const BLOCK_MINUTES = 30;
/** Another read of the time is made at most this many times when it changes under a claim. */
const ATTEMPTS = 3;

export const hourlyRef = (projectId: string, n: number): string => `hourly:${projectId}:${n}`;

/** Whether the business has an active Care or Care Plus subscription (a real one: a test subscription never earns a real rate). */
async function isCareClient(db: D1Database, businessId: string): Promise<boolean> {
  return (await listSubscriptions(db, { statuses: ["active"], businessId })).some((s) => !s.test && (s.packageKey === "care" || s.packageKey === "care_plus"));
}

/**
 * Drafts one invoice for all the billable, finished time on a project that is not on an invoice yet, and puts it up for approval. The minutes are rounded up to whole 30-minute blocks in
 * total, at the catalog's hourly rate (the Care rate for a client with an active Care or Care Plus subscription). The entries are tagged with the invoice's ref in the same batch as the
 * draft, guarded in the statement itself, so the same time can never go on two invoices, even for two requests at once. Returns null when there is nothing to bill (no such project, a
 * test project, or no finished billable time left), and for a request that lost the time to another one.
 */
export async function hourlyInvoice(env: Env, o: { projectId: string; now: Date }): Promise<{ invoice: InvoiceRow; approval: Approval | null } | null> {
  const db = env.DB;
  const project = await getProject(db, o.projectId);
  if (!project || project.test) return null;
  const hourly = await getPackage(db, "hourly");
  if (!hourly) throw new Error("There is no hourly price set in the catalog.");
  const care = hourly.altPriceCents !== null && (await isCareClient(db, project.businessId));
  const rateCents = care ? hourly.altPriceCents! : hourly.priceCents;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const time = await unbilledBillableMinutes(db, project.id);
    if (time.entryIds.length === 0) return null;
    // Read the time first, then the count: a draft made in between can only make the claim below fail, never tag time onto a ref that is taken.
    const n = (await listInvoices(db, { kinds: ["hourly"], projectId: project.id })).length + 1;
    const blocks = Math.ceil(time.minutes / BLOCK_MINUTES);
    const hours = (blocks * BLOCK_MINUTES) / 60;
    const amountCents = Math.round((rateCents * blocks * BLOCK_MINUTES) / 60);
    const what = `Hourly work: ${hours} ${hours === 1 ? "hour" : "hours"} at ${dollars(rateCents)} an hour${care ? " (Care rate)" : ""}`;
    const invoice = await insertDraftInvoiceClaimingTime(db, {
      businessId: project.businessId, dealId: project.dealId, documentId: project.documentId, projectId: project.id, kind: "hourly", ref: hourlyRef(project.id, n), test: false,
      description: what, lines: [{ description: what, amountCents }], expect: { entries: time.entryIds.length, minutes: time.minutes },
    });
    if (invoice) return { invoice, approval: await proposeInvoice(env, invoice.id) };
  }
  return null;
}
