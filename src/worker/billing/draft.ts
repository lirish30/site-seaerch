import { dollars } from "../../client/packagesView";
import { createApproval, toApproval, type Approval } from "../db/approvals";
import { getBusiness } from "../db/businesses";
import { getInvoice, insertDraftInvoice, type InvoiceRow } from "../db/invoices";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { zoneOf } from "../sop/cadence";
import "../approvals/invoiceSend"; // the kind must be registered before an approval of it is made
import { parseBillingConfig } from "./config";
import { addDays, calendarDateIn } from "./dates";
import { invoiceRecipient, renderInvoiceMail, signOff, type Recipient } from "./mail";

export const SEND_KIND = "invoice.send";

const waiting = (db: D1Database, invoiceId: string) => db.prepare(
  `SELECT * FROM approvals WHERE kind = '${SEND_KIND}' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ? ORDER BY created_at, id`,
).bind(invoiceId).all<Parameters<typeof toApproval>[0]>().then((r) => r.results.map(toApproval));

/** What the client's mail will be, as far as it can be known before the invoice exists at Stripe (the link and the exact due date are made when it is approved). */
async function previewOf(env: Env, inv: InvoiceRow): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  let who: Recipient | null = null, problem = "";
  try { who = await invoiceRecipient(env, inv); } catch (e) { problem = e instanceof Error ? e.message : "no recipient"; }
  const clientName = who?.clientName || (await getBusiness(env.DB, inv.businessId))?.name || "the client";
  const dueOn = addDays(calendarDateIn(getMailDeps().now(), zoneOf(settings)), parseBillingConfig(settings.billing_config).netDays);
  const mail = renderInvoiceMail({ ...inv, dueOn }, "(the link is made when you approve)", { clientName, contactName: who?.contactName ?? "", yourName: signOff(settings) });
  const toLine = !who ? `To: nobody yet (${problem})`
    : inv.test ? `To: ${settings.your_name.trim() || "You"} <${settings.contact_email.trim()}> (a test: nothing goes to ${who.to})`
    : `To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`;
  const preview = [
    toLine, `Subject: ${inv.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    `Invoice: ${inv.description}`,
    ...inv.lines.map((l) => `  - ${l.description}: ${dollars(l.amountCents)}`),
    `Total: ${dollars(inv.amountCents)}`,
    `Due: ${dueOn} (${parseBillingConfig(settings.billing_config).netDays} days after it is sent)`,
    "", "Nothing is made at Stripe, and nothing is mailed, until you approve.",
  ].join("\n");
  return { title: `Send invoice ${inv.description} to ${clientName}`.replace(/\s+/g, " ").slice(0, 200), preview };
}

/**
 * Puts a draft invoice up for approval: the mail the client will get, the lines, the total and the due date. One waiting approval per invoice: a second call returns the first.
 * Approving it is what makes the invoice at Stripe and mails the link. Refuses an invoice that is not a draft.
 */
export async function proposeInvoice(env: Env, invoiceId: string): Promise<Approval> {
  const db = env.DB;
  const inv = await getInvoice(db, invoiceId);
  if (!inv) throw new Error("There is no such invoice.");
  if (inv.status !== "draft") throw new Error(`This invoice is ${inv.status}, not a draft.`);
  const first = (await waiting(db, inv.id))[0];
  if (first) return first;

  const { title, preview } = await previewOf(env, inv);
  const a = await createApproval(db, {
    kind: SEND_KIND, title, preview, payload: { invoiceId: inv.id },
    record_type: inv.projectId ? "project" : "business", record_id: inv.projectId ?? inv.businessId, drafted_by: "logan",
  });
  // Two callers at once: the earliest approval stands, the other is dropped.
  const winner = (await waiting(db, inv.id))[0];
  if (winner && winner.id !== a.id) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    return winner;
  }
  return a;
}

/**
 * Makes the draft invoice (once per `ref`) and puts it up for approval. A second call for the same ref finds the first. `approval` is null when the invoice already existed and is no
 * longer a draft (it has been sent, paid or voided), so there is nothing left to approve.
 */
export async function draftAndPropose(env: Env, o: Parameters<typeof insertDraftInvoice>[1]): Promise<{ invoice: InvoiceRow; approval: Approval | null }> {
  const { invoice } = await insertDraftInvoice(env.DB, o);
  if (invoice.status !== "draft") return { invoice, approval: null };
  return { invoice, approval: await proposeInvoice(env, invoice.id) };
}
