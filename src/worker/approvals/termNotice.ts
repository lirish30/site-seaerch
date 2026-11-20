import { z } from "zod";
import { dollars } from "../../client/packagesView";
import { mainMailboxProblem } from "../booking/mail";
import { existingCare, invoiceRecipient, renderTermNotice, signOff, subscriptionPlanName } from "../billing/mail";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { getByApproval } from "../db/messages";
import { getPackage } from "../db/packages";
import { getSettings } from "../db/settings";
import { getSubscription } from "../db/subscriptions";
import type { Env } from "../env";
import { sendEmail } from "../mail/send";
import { registerHandler } from "./registry";

const Payload = z.object({ subscriptionId: z.string().min(1) });
export type TermNoticePayload = z.infer<typeof Payload>;

registerHandler({
  kind: "subscription.term_notice",
  label: "Send term notice",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because weeks may have passed: only the subscription id is trusted from the payload. A subscription that is no longer active, or no longer set to
   * convert to Care (Logan chose a refresh, or it was cancelled or already converted), is left alone and nothing is mailed. Otherwise the fixed notice goes to the client with the approval id
   * as the once-only key (a retry whose mail already went mails nothing), and a line is logged once. A test subscription goes to the owner only, with "[Test] " on the subject. Nothing is made at Stripe.
   */
  async execute(env: Env, p: TermNoticePayload, a: Approval) {
    const db = env.DB;
    const sub = await getSubscription(db, p.subscriptionId);
    if (!sub) throw new Error("This subscription was not found.");
    const plan = await subscriptionPlanName(env, sub);
    const care = await getPackage(db, "care");
    const own = await existingCare(db, sub); // the document's own Care plan, when it has one still going, carries on at its own price
    const careCents = own.live?.monthlyCents ?? care?.priceCents;
    const note = (to: string) => logActivityOnce(db, sub.businessId, "note", `term notice sent: ${plan} ends ${sub.termEndsOn ?? "soon"}, then Care${careCents !== undefined ? ` ${dollars(careCents)} a month` : ""}${sub.test ? " (test)" : ""} to ${to}`);
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await note(mailed.counterpart); return; } // an earlier run of this approval mailed it and something after the mail failed
    if (sub.status !== "active" || sub.endAction !== "convert_to_care" || !sub.termEndsOn) return; // no longer true: nothing to tell the client

    if (careCents === undefined) throw new Error("The Care package is missing from the catalog, so the notice cannot say the new price.");
    const settings = await getSettings(db);
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, sub);
    const owner = settings.contact_email.trim();
    if (sub.test && !owner) throw new Error("Add your contact email in Settings first: a test notice goes to it.");
    if (!sub.test) {
      // The client has paid before, so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: sub.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    const mail = renderTermNotice(sub, { clientName: who.clientName, contactName: who.contactName, yourName: signOff(settings), planName: plan, careMonthlyCents: careCents, careContinues: !!own.live });
    const to = sub.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${sub.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(sub.test ? {} : { businessId: sub.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await note(to);
  },
});
