import { z } from "zod";
import { dollars } from "../../client/packagesView";
import { mainMailboxProblem } from "../booking/mail";
import { invoiceRecipient, renderSubscriptionLink, signOff, subscriptionPlanName } from "../billing/mail";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import { getSubscription, markSubscription } from "../db/subscriptions";
import { legalGate, parseDocumentsConfig } from "../documents/config";
import { clientBase } from "../documents/mail";
import { CLIENT_BASE_PROBLEM } from "../documents/service";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { sendEmail } from "../mail/send";
import { stripeMode } from "../stripe/client";
import { registerHandler } from "./registry";

const Payload = z.object({ subscriptionId: z.string().min(1) });
export type SubscriptionStartPayload = z.infer<typeof Payload>;

registerHandler({
  kind: "subscription.start",
  label: "Send subscription link",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is checked again at approval, because days may have passed: only the subscription id is trusted from the payload. The subscription must still be `proposed` (or `link_sent`,
   * this same approval's retry), Stripe must be set up (a test subscription only ever through a test key), the client link base must be an https address, and a REAL subscription needs the
   * lawyer's review recorded (`legalGate`, as a proposal does: the auto-renewal clause, spec §16). Then, in order and each step safe to repeat: issue the token (kept on a retry) and
   * set `link_sent`, mail `<CLIENT_LINK_BASE>/s/<token>` with the approval id as the once-only key, log it once. A retry whose mail already went mails nothing. A test subscription goes to
   * the owner only, with "[Test] " on the subject. Nothing is made at Stripe here: the client's own page makes the Checkout.
   */
  async execute(env: Env, p: SubscriptionStartPayload, a: Approval) {
    const db = env.DB;
    let sub = await getSubscription(db, p.subscriptionId);
    if (!sub) throw new Error("This subscription was not found.");
    const plan = await subscriptionPlanName(env, sub);
    const note = (to: string) => logActivityOnce(db, sub!.businessId, "note", `subscription link sent: ${plan} ${dollars(sub!.monthlyCents)} a month ${sub!.test ? "(test) " : ""}to ${to}`);
    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await note(mailed.counterpart); return; } // an earlier run of this approval mailed it and something after the mail failed
    if (sub.status !== "proposed" && sub.status !== "link_sent") throw new Error(`This subscription is ${sub.status}, not waiting to be sent. Reject this approval.`);

    const settings = await getSettings(db);
    const key = env.STRIPE_SECRET_KEY, mode = stripeMode(key);
    if (!key || !mode) throw new Error("Stripe is not set up: add the Stripe secret key first, then approve this again.");
    if (mode === "live" && sub.test) throw new Error("This is a test subscription and Stripe is in live mode, so its link will not go out. Switch Stripe to a test key, or reject this.");
    const base = clientBase(env);
    if (!base) throw new Error(CLIENT_BASE_PROBLEM);
    if (!sub.test) {
      const gate = legalGate(parseDocumentsConfig(settings.documents_config));
      if (gate) throw new Error(gate);
    }
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, sub);
    const owner = settings.contact_email.trim();
    if (sub.test && !owner) throw new Error("Add your contact email in Settings first: a test link goes to it.");
    if (!sub.test) {
      // The client has paid before (the deposit marks the lead won), so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: sub.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    // The move to link_sent comes first: the link the mail carries then already works, and a failed mail is repeated by the retry with the same token.
    await markSubscription(db, sub.id, { status: "link_sent", token: sub.token ?? newClientToken() }, { from: ["proposed", "link_sent"] });
    sub = (await getSubscription(db, sub.id)) ?? sub;
    if (sub.status !== "link_sent" || !sub.token) throw new Error("This subscription changed while its link was being made. Look at it again, then approve this again.");

    const mail = renderSubscriptionLink(sub, `${base}/s/${sub.token}`, { clientName: who.clientName, contactName: who.contactName, yourName: signOff(settings), planName: plan });
    const to = sub.test ? owner : who.to;
    await sendEmail(env, {
      mailbox: "main", to, subject: `${sub.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(sub.test ? {} : { businessId: sub.businessId }),
    }, { approvalId: a.id, skipLimits: true });
    await note(to);
  },
});
