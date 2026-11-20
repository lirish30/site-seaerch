import { z } from "zod";
import { dollars } from "../../client/packagesView";
import { mainMailboxProblem } from "../booking/mail";
import { parseBillingConfig } from "../billing/config";
import { ensureStripeCustomer } from "../billing/customer";
import { invoiceRecipient, renderInvoiceMail, signOff } from "../billing/mail";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { attachStripeInvoice, getInvoice } from "../db/invoices";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import { stripeFetch } from "../documents/deposit";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { createInvoice, stripeMode, voidInvoice } from "../stripe/client";
import { registerHandler } from "./registry";

const Payload = z.object({ invoiceId: z.string().min(1) });
export type InvoiceSendPayload = z.infer<typeof Payload>;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

registerHandler({
  kind: "invoice.send",
  label: "Send invoice",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is checked again at approval, because days may have passed: only the invoice id is trusted from the payload. Then, in order and each step safe to repeat: make the
   * customer, make the invoice at Stripe (one idempotency key per invoice, so a retry replays), attach it to the draft (guarded: only a draft takes it), mail Stripe's hosted link with the
   * approval id as the once-only key, log it once. An invoice that is no longer a draft is only mailed when this approval has not mailed it yet (a retry after Stripe succeeded and the mail
   * failed); one that was paid, voided or already mailed by this approval sends nothing. A test invoice goes to the owner only, with "[Test] " on the subject.
   */
  async execute(env: Env, p: InvoiceSendPayload, a: Approval) {
    const db = env.DB;
    let inv = await getInvoice(db, p.invoiceId);
    if (!inv) throw new Error("This invoice was not found.");
    const draft = inv.status === "draft";
    if (!draft && !(inv.status === "open" && inv.hostedUrl)) return; // paid, void, uncollectible: nothing to send
    const mailed = (await getByApproval(db, a.id))?.status === "sent";
    const note = () => logActivityOnce(db, inv!.businessId, "invoice_sent", `${inv!.description} ${dollars(inv!.amountCents)} (${inv!.ref}) ${inv!.test ? "(test) " : ""}sent, due ${inv!.dueOn ?? "on receipt"}`);
    if (mailed) { if (!draft) await note(); return; }

    const settings = await getSettings(db);
    const key = env.STRIPE_SECRET_KEY;
    if (draft) {
      const mode = stripeMode(key);
      if (!key || !mode) throw new Error("Stripe is not set up: add the Stripe secret key first, then approve this again.");
      if (mode === "live" && inv.test) throw new Error("This is a test invoice and Stripe is in live mode, so it will not be made. Switch Stripe to a test key, or reject this.");
    }
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, inv);
    const owner = settings.contact_email.trim();
    if (inv.test && !owner) throw new Error("Add your contact email in Settings first: a test invoice goes to it.");
    if (!inv.test) {
      // The client has paid before (the deposit marks the lead won), so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: inv.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    if (draft && key) {
      const f = stripeFetch({});
      const customerId = await ensureStripeCustomer(env, { businessId: inv.businessId, name: who.clientName, email: who.to }, f);
      const brand = oneLine(settings.business_name) || oneLine(settings.your_name);
      const footer = [brand, oneLine(settings.contact_email)].filter(Boolean).join(" · ");
      const made = await createInvoice(f, key, {
        customerId, lines: inv.lines, daysUntilDue: parseBillingConfig(settings.billing_config).netDays, ref: inv.ref, kind: inv.kind, businessId: inv.businessId,
        ...(inv.documentId ? { documentId: inv.documentId } : {}), ...(footer ? { footer } : {}),
      }, `inv:${inv.ref}`);
      const attached = await attachStripeInvoice(db, inv.id, { stripeCustomerId: customerId, stripeInvoiceId: made.invoiceId, hostedUrl: made.hostedUrl, dueOn: made.dueOn, now: getMailDeps().now().toISOString() });
      inv = (await getInvoice(db, inv.id)) ?? inv;
      if (!attached && !(inv.status === "open" && inv.stripeInvoiceId === made.invoiceId)) {
        // The draft was thrown away (or taken another way) while Stripe was working: what was just made is cancelled so it cannot be paid, and nothing is mailed.
        await voidInvoice(f, key, made.invoiceId).catch((e) => console.error("invoice: could not void an invoice made for a discarded draft", e instanceof Error ? e.message : "unknown error"));
        return;
      }
    }

    const link = inv.hostedUrl;
    if (!link || !link.startsWith("https://")) throw new Error("This invoice has no Stripe link to send.");
    const mail = renderInvoiceMail(inv, link, { clientName: who.clientName, contactName: who.contactName, yourName: signOff(settings) });
    await sendEmail(env, {
      mailbox: "main", to: inv.test ? owner : who.to, subject: `${inv.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(inv.test ? {} : { businessId: inv.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await note();
  },
});
