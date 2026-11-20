import { z } from "zod";
import { dollars } from "../../client/packagesView";
import { mainMailboxProblem } from "../booking/mail";
import { calendarDateIn } from "../billing/dates";
import { invoiceRecipient, renderPauseNotice, signOff, type PauseNoticeMail } from "../billing/mail";
import { reminderBase } from "./invoiceReminder";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { holdForInvoice } from "../db/holds";
import { getInvoice, type InvoiceRow } from "../db/invoices";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { zoneOf } from "../sop/cadence";
import type { Settings } from "../types";
import { registerHandler } from "./registry";

const Payload = z.object({ invoiceId: z.string().min(1) });
export type PauseNoticePayload = z.infer<typeof Payload>;

export const PAUSE_NOTICE_KIND = "invoice.pause_notice";

/** The fixed notice, from the invoice and the settings as they are now; `today` is the mail clock's day, for the preview and the send alike, so both say the same. */
export function pauseMail(settings: Settings, inv: InvoiceRow, link: string, contactName: string): PauseNoticeMail {
  const today = calendarDateIn(getMailDeps().now(), zoneOf(settings));
  return renderPauseNotice(inv, link, { contactName, yourName: signOff(settings), today });
}

registerHandler({
  kind: PAUSE_NOTICE_KIND,
  label: "Send pause notice",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the invoice id is trusted from the payload. The notice says work has paused and resumes when the invoice is paid, so
   * it is NOT mailed when that is no longer true: the invoice is paid, voided or written off, or its hold is already lifted (paid, voided or lifted by Logan meanwhile). A line on the lead's
   * timeline says so and the approval is done. Otherwise the fixed notice goes to the client with the approval id as the once-only key (a retry whose mail already went mails nothing), and a line
   * is logged once. A test invoice goes to the owner only, with "[Test] " on the subject. The hold itself is not touched.
   */
  async execute(env: Env, p: PauseNoticePayload, a: Approval) {
    const db = env.DB;
    const inv = await getInvoice(db, p.invoiceId);
    if (!inv) throw new Error("This invoice was not found.");
    const what = inv.description.replace(/\s+/g, " ").trim().slice(0, 120);
    const note = (to: string) => logActivityOnce(db, inv.businessId, "note", `pause notice sent: ${what} ${dollars(inv.amountCents)} (${inv.ref}) ${inv.test ? "(test) " : ""}to ${to}`);
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await note(mailed.counterpart); return; } // an earlier run of this approval mailed it and something after the mail failed

    const skip = (why: string) => logActivityOnce(db, inv.businessId, "note", `pause notice not sent: ${what} (${inv.ref}) ${why}`);
    const hold = await holdForInvoice(db, inv.id);
    if (!hold || hold.liftedAt) { await skip("the hold is already lifted, so nothing was mailed"); return; }
    if (inv.status !== "open" && inv.status !== "failed") { await skip(`is ${inv.status}, so nothing was mailed`); return; }
    if (!reminderBase(inv)) { await skip("has no due date to count from, so nothing was mailed"); return; }
    const link = inv.hostedUrl;
    if (!link || !link.startsWith("https://")) throw new Error("This invoice has no Stripe link to send.");

    const settings = await getSettings(db);
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, inv);
    const owner = settings.contact_email.trim();
    if (inv.test && !owner) throw new Error("Add your contact email in Settings first: a test notice goes to it.");
    if (!inv.test) {
      // The client has paid before, so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: inv.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    const mail = pauseMail(settings, inv, link, who.contactName);
    const to = inv.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${inv.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(inv.test ? {} : { businessId: inv.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await note(to);
  },
});
