import { z } from "zod";
import { mainMailboxProblem } from "../booking/mail";
import { calendarDateIn } from "../billing/dates";
import { signOff } from "../billing/mail";
import { logActivityOnce } from "../db/activity";
import type { Approval } from "../db/approvals";
import { getLadderRow, moveLadder } from "../db/ladder";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { PERSONAL_LINE_MAX, LADDER_STEP_TITLE, isLadderMailStep, ladderMail } from "../ladder/mail";
import { clientBlock, ladderRecipient, reviewLinkFor } from "../ladder/recipient";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { zoneOf } from "../sop/cadence";
import { registerHandler } from "./registry";

const Payload = z.object({ ladderId: z.string().min(1), personalLine: z.string().max(PERSONAL_LINE_MAX, `The personal line is at most ${PERSONAL_LINE_MAX} characters.`).optional() });
export type LadderMailPayload = z.infer<typeof Payload>;

export const LADDER_MAIL_KIND = "ladder.mail";

registerHandler({
  kind: LADDER_MAIL_KIND,
  label: "Send",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the ladder step's id (and the optional personal line, which the owner may have edited) are trusted from the payload. A step that is no
   * longer `drafted` (skipped, or marked done by hand, meanwhile) is NOT mailed, and neither is one for a client now on a billing hold or blocked by the do-not-contact list: a line on the client's timeline says so
   * and the approval is done (a held or blocked step goes to `due` so it shows on Today). Otherwise the fixed mail goes from the main mailbox with the approval id as the once-only key (a retry whose mail already went
   * mails nothing), the step becomes `done` and a line is logged once. A missing mailbox, address or review link throws, which puts the approval back to pending with the reason.
   */
  async execute(env: Env, p: LadderMailPayload, a: Approval) {
    const db = env.DB;
    const row = await getLadderRow(db, p.ladderId);
    if (!row) throw new Error("This ladder step was not found.");
    if (!isLadderMailStep(row.step)) throw new Error("This ladder step is not a mail.");
    const title = LADDER_STEP_TITLE[row.step];
    const now = getMailDeps().now().toISOString();
    const finish = async (to: string) => {
      await moveLadder(db, row.id, ["drafted"], "done", { now });
      await logActivityOnce(db, row.businessId, "ladder_sent", `${title} sent to ${to}`);
    };

    const mailed = await getByApproval(db, a.id);
    if (mailed?.status === "sent") { await finish(mailed.counterpart); return; } // an earlier run of this approval mailed it and something after the mail failed

    const skip = (why: string) => logActivityOnce(db, row.businessId, "note", `${title} (due ${row.dueOn}) not sent: ${why}`);
    if (row.status !== "drafted" || (row.approvalId && row.approvalId !== a.id)) { await skip(`the step is ${row.status === "drafted" ? "now tied to another draft" : row.status}, so nothing was mailed`); return; }

    const who = await ladderRecipient(db, row.businessId);
    if (!who) throw new Error("This client has no contact email to send to: add one on the lead record first.");
    const blocked = await clientBlock(db, row.businessId, { step: row.step, email: who.to });
    if (blocked) {
      await moveLadder(db, row.id, ["drafted"], "due", { note: `not sent: ${blocked}` });
      await skip(`${blocked}, so nothing was mailed`);
      return;
    }
    const link = row.step === "review_request" ? await reviewLinkFor(db, row.businessId, row) : null;
    if (row.step === "review_request" && !link) throw new Error("This review request has no Google review link: add one on the client's page first.");

    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const settings = await getSettings(db);
    const year = Number(row.step === "december_letter" ? row.dueOn.slice(0, 4) : calendarDateIn(getMailDeps().now(), zoneOf(settings)).slice(0, 4));
    const mail = ladderMail(row.step, { contactName: who.contactName, yourName: signOff(settings), link, year, personalLine: p.personalLine ?? "" });
    await sendEmail(env, { mailbox: "main", to: who.to, subject: mail.subject, body: mail.body, includeFooter: false, businessId: row.businessId }, { approvalId: a.id, skipLimits: true });
    await finish(who.to);
  },
});
