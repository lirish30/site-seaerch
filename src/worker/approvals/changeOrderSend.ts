import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import { createApproval, toApproval, type Approval } from "../db/approvals";
import { logActivityOnce } from "../db/activity";
import { getChangeOrder, type ChangeOrder } from "../db/changeOrders";
import { getSettings } from "../db/settings";
import { dollars } from "../../client/packagesView";
import { hoursText } from "../changeorders/mail";
import { mailChangeOrderLink, mailFor, sealChangeOrder, sendProblems } from "../changeorders/service";
import { getMailDeps } from "../mail/deps";

const Payload = z.object({ changeOrderId: z.string().min(1) });
export type ChangeOrderSendPayload = z.infer<typeof Payload>;

const waiting = (db: D1Database, changeOrderId: string) => db.prepare(
  `SELECT * FROM approvals WHERE kind = 'change_order.send' AND status = 'pending' AND json_extract(payload, '$.changeOrderId') = ? ORDER BY created_at, id`,
).bind(changeOrderId).all<Parameters<typeof toApproval>[0]>().then((r) => r.results.map(toApproval));

const bullets = (items: string[]) => items.map((i) => `  - ${i}`);

/**
 * Puts a draft change order up for approval: the mail the client will get, the hours, the rate, the price and the schedule impact. The approval IS Logan's countersignature
 * (the order is sealed with the hash of exactly the content he read). One waiting approval per order: a second call returns the first. An edit to the draft withdraws it
 * (`editDraft`), so what he approves is what is sent. Nothing is mailed until he approves.
 */
export async function createChangeOrderSendApproval(env: Env, co: ChangeOrder): Promise<Approval> {
  if (co.status !== "draft") throw new Error(`this change order is ${co.status}, not a draft`);
  const db = env.DB;
  const first = (await waiting(db, co.id))[0];
  if (first) return first;

  const settings = await getSettings(db);
  const c = co.content;
  const m = mailFor(env, co, settings);
  const who = co.test ? `${settings.your_name.trim() || "You"} <${m.to}> (a test: nothing goes to ${c.contactEmail.trim() || "the client"})` : `${c.contactName.trim() || c.clientName} <${m.to}>`;
  const preview = [
    `To: ${who}`, `Subject: ${m.subject}`, "", m.body, "",
    `Change order ${c.reference}: ${c.title}`,
    `Hours: ${hoursText(c.hours)} at ${dollars(c.rateCents)} an hour`,
    `Price: ${dollars(c.priceCents)}`,
    `Schedule impact: ${c.scheduleImpactDays === null ? "not stated" : c.scheduleImpactDays === 0 ? "none" : `${c.scheduleImpactDays} days`}`,
    ...(c.deliverables.length ? ["Included:", ...bullets(c.deliverables)] : []),
    ...(c.notIncluded.length ? ["Not included:", ...bullets(c.notIncluded)] : []),
    "", `Approving countersigned as ${settings.your_name.trim() || "you"} <${settings.contact_email.trim()}>. Nothing starts until the client signs and the invoice is paid.`,
  ].join("\n");
  const a = await createApproval(db, {
    kind: "change_order.send", title: `Send change order ${c.reference} to ${c.clientName}`.slice(0, 200), preview, payload: { changeOrderId: co.id } satisfies ChangeOrderSendPayload,
    record_type: "project", record_id: co.projectId, drafted_by: "logan",
  });
  // Two callers at once: the earliest approval stands, the other is dropped.
  const winner = (await waiting(db, co.id))[0];
  if (winner && winner.id !== a.id) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    return winner;
  }
  return a;
}

registerHandler({
  kind: "change_order.send",
  label: "Send change order",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is checked again at approval, because days may have passed (`sendProblems`: the lawyer's review for a real order, the mailbox, the contact, the project). Then, in order and
   * each step safe to repeat: seal the order (a retry of the same approval finds it already sent and keeps its token and hash), mail the link with the approval id as the once-only
   * key, log it once. A test order goes to the owner only, with "[Test] " on the subject.
   */
  async execute(env: Env, p: ChangeOrderSendPayload, a: Approval) {
    const co = await getChangeOrder(env.DB, p.changeOrderId);
    if (!co) throw new Error("this change order was not found");
    const problems = await sendProblems(env, co, { approvalId: a.id });
    if (problems.length) throw new Error(problems[0]);
    const settings = await getSettings(env.DB);
    const sent = co.status === "draft" ? await sealChangeOrder(env, co, { now: getMailDeps().now(), approvalId: a.id, settings }) : co;

    const to = await mailChangeOrderLink(env, sent, settings, a.id);
    await logActivityOnce(env.DB, sent.businessId, "change_order_sent", `${sent.content.reference} ${sent.test ? "(test) " : ""}to ${to}, expires ${sent.expiresAt?.slice(0, 10)}`);
  },
});
