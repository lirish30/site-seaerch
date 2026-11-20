import { ChangeOrderStateError, getChangeOrder } from "../db/changeOrders";
import { getProject } from "../db/projects";
import type { Approval } from "../db/approvals";
import type { InvoiceRow } from "../db/invoices";
import type { Env } from "../env";
import { draftAndPropose } from "./draft";

export const changeOrderRef = (changeOrderId: string): string => `co:${changeOrderId}`;

/**
 * The invoice for a signed change order, drafted (once: the ref is `co:<id>`) and put up for approval. The amount is the price the client signed (`content.priceCents`), never today's
 * catalog, as one line `<reference>: <title>`. Refuses, in a plain sentence (ChangeOrderStateError, a 409 at the route), an order that is not signed, is already paid (by hand or by Stripe),
 * is a test, or belongs to a cancelled project. A second call finds the first invoice (and its waiting approval, or makes a new one when the earlier approval was rejected).
 */
export async function invoiceChangeOrder(env: Env, changeOrderId: string): Promise<{ invoice: InvoiceRow; approval: Approval | null }> {
  const co = await getChangeOrder(env.DB, changeOrderId);
  if (!co) throw new ChangeOrderStateError("There is no such change order.");
  if (co.test) throw new ChangeOrderStateError("A test change order is not invoiced.");
  if (co.status !== "signed") throw new ChangeOrderStateError("This change order has not been signed, so it cannot be invoiced.");
  if (co.paidAt !== null) throw new ChangeOrderStateError("This change order is already paid, so it cannot be invoiced.");
  const project = await getProject(env.DB, co.projectId);
  if (!project || project.status === "cancelled") throw new ChangeOrderStateError("This project is cancelled, so its change order is not invoiced.");
  const what = `${co.content.reference}: ${co.content.title}`;
  return draftAndPropose(env, {
    businessId: co.businessId, dealId: co.dealId, documentId: project.documentId, projectId: co.projectId, changeOrderId: co.id, subscriptionId: null,
    kind: "change_order", ref: changeOrderRef(co.id), test: false, description: what, lines: [{ description: what, amountCents: co.content.priceCents }],
  });
}
