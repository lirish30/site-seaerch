import { z } from "zod";
import { dollars } from "../../client/packagesView";
import { mainMailboxProblem } from "../booking/mail";
import { parseBillingConfig } from "../billing/config";
import { addDays, calendarDateIn } from "../billing/dates";
import { invoiceRecipient, renderReminder, signOff, type ReminderMail } from "../billing/mail";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { getInvoice, type InvoiceRow } from "../db/invoices";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { zoneOf } from "../sop/cadence";
import type { Settings } from "../types";
import { registerHandler } from "./registry";

const Payload = z.object({ invoiceId: z.string().min(1), step: z.number().int().min(1).max(6) });
export type InvoiceReminderPayload = z.infer<typeof Payload>;

export const REMINDER_KIND = "invoice.reminder";

/** The date the ladder and the pause count from: the day an autopay invoice first failed, else the invoice's due date. Null when it has neither. */
export const reminderBase = (inv: Pick<InvoiceRow, "failedOn" | "dueOn">): string | null => inv.failedOn ?? inv.dueOn;

/**
 * The fixed reminder for `step`, from the invoice and the settings as they are now. `total` is how many steps the ladder has (a step past the end counts as the last), `offset` is the step's own
 * distance from the due date, and the pause date is the base date plus `pauseAfterDays`. Null when the invoice has no date to count from.
 */
export function reminderMail(settings: Settings, inv: InvoiceRow, step: number, link: string, contactName: string): (ReminderMail & { pauseOn: string }) | null {
  const base = reminderBase(inv);
  if (!base) return null;
  const cfg = parseBillingConfig(settings.billing_config);
  const pauseOn = addDays(base, cfg.pauseAfterDays);
  const offset = cfg.reminderOffsets[step - 1];
  const today = calendarDateIn(getMailDeps().now(), zoneOf(settings)); // the mail clock, for the preview and the send alike, so both say the same
  const mail = renderReminder(step, Math.max(step, cfg.reminderOffsets.length), inv, link, { contactName, yourName: signOff(settings), pauseOn, today, ...(offset !== undefined ? { offset } : {}) });
  return { ...mail, pauseOn };
}

registerHandler({
  kind: REMINDER_KIND,
  label: "Send reminder",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the invoice id and the step are trusted from the payload. An invoice that is no longer open or failed (paid, voided,
   * written off) is NOT mailed: a line on the lead's timeline says so and the approval is done. Otherwise the fixed reminder goes to the client with the approval id as the once-only key (a retry
   * whose mail already went mails nothing), and a line is logged once. A test invoice goes to the owner only, with "[Test] " on the subject. Nothing is made at Stripe.
   */
  async execute(env: Env, p: InvoiceReminderPayload, a: Approval) {
    const db = env.DB;
    const inv = await getInvoice(db, p.invoiceId);
    if (!inv) throw new Error("This invoice was not found.");
    const what = inv.description.replace(/\s+/g, " ").trim().slice(0, 120);
    const note = (to: string) => logActivityOnce(db, inv.businessId, "note", `reminder ${p.step} sent: ${what} ${dollars(inv.amountCents)} (${inv.ref}) ${inv.test ? "(test) " : ""}to ${to}`);
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await note(mailed.counterpart); return; } // an earlier run of this approval mailed it and something after the mail failed

    const skip = (why: string) => logActivityOnce(db, inv.businessId, "note", `reminder ${p.step} not sent: ${what} (${inv.ref}) ${why}`);
    if (inv.status !== "open" && inv.status !== "failed") { await skip(`is ${inv.status}, so nothing was mailed`); return; }
    if (!reminderBase(inv)) { await skip("has no due date to count from, so nothing was mailed"); return; }
    const link = inv.hostedUrl;
    if (!link || !link.startsWith("https://")) throw new Error("This invoice has no Stripe link to send.");

    const settings = await getSettings(db);
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, inv);
    const owner = settings.contact_email.trim();
    if (inv.test && !owner) throw new Error("Add your contact email in Settings first: a test reminder goes to it.");
    if (!inv.test) {
      // The client has paid before, so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: inv.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    const mail = reminderMail(settings, inv, p.step, link, who.contactName)!;
    const to = inv.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${inv.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(inv.test ? {} : { businessId: inv.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await note(to);
  },
});
