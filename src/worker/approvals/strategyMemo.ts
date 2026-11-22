import { z } from "zod";
import { mainMailboxProblem } from "../booking/mail";
import { invoiceRecipient, signOff, type Recipient } from "../billing/mail";
import { isClient } from "../clients/record";
import { checkConflict } from "../conflict";
import { logActivityOnce } from "../db/activity";
import { createApprovalOnce, toApproval, type Approval } from "../db/approvals";
import { isOnHold } from "../db/holds";
import { getByApproval } from "../db/messages";
import { getSettings } from "../db/settings";
import { getMemo, markMemoSent, setMemoLinks, unmarkMemoSent, type StrategyMemo } from "../db/strategy";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { MemoFacts } from "../strategy/facts";
import { renderStrategyMail, strategyLink } from "../strategy/mail";
import { NO_LINK_BASE } from "./seoReport";
import { registerHandler } from "./registry";

// The approval of a client's strategy memo (Plan 16), the mirror of the Local SEO report's: one approval per memo, the mail goes only when Logan approves, and everything is read again when it runs. The direction
// of imports is queue -> approvals (the Claude task kind proposes this approval), never the other way.

const KIND = "strategy.memo";
const Payload = z.object({ memoId: z.string().min(1) });
export type StrategyMemoApprovalPayload = z.infer<typeof Payload>;

/** What the card shows of Claude's words (the memo's body is `{}` until Claude has written it). */
const Words = z.object({
  standing: z.string().optional(),
  priorities: z.array(z.object({ title: z.string().optional() })).optional(),
});

const existingApproval = async (db: D1Database, memoId: string): Promise<Approval | null> => {
  const row = await db.prepare(`SELECT * FROM approvals WHERE kind = ? AND json_extract(payload, '$.memoId') = ? ORDER BY created_at, id LIMIT 1`).bind(KIND, memoId).first<Parameters<typeof toApproval>[0]>();
  return row ? toApproval(row) : null;
};

/**
 * The approval's title and preview from the memo as it is now: who it goes to, the subject, the mail as it will read, and, below it, what the client will find on the memo page (the standing paragraph and the
 * priorities). A recipient or a link that cannot be made yet is said on the card, never thrown: the approval refuses or throws when it runs.
 */
async function describe(env: Env, memo: StrategyMemo): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  const facts = MemoFacts.safeParse(memo.facts);
  let who: Recipient | null = null;
  let whoProblem = "";
  try { who = await invoiceRecipient(env, { documentId: null, projectId: null, businessId: memo.businessId }); }
  catch (e) { whoProblem = e instanceof Error ? e.message : "no contact"; }
  const owner = settings.contact_email.trim();
  const link = strategyLink(env, memo.token);
  const clientName = (facts.success && facts.data.clientName) || who?.clientName || "this client";
  const mail = renderStrategyMail({ clientName, contactName: who?.contactName ?? "", yourName: signOff(settings), link: link ?? "(no link yet)" });

  const contact = who ? `${who.contactName || who.clientName} <${who.to}>` : `nobody yet (this client has no contact email: add one first; ${whoProblem})`;
  const to = memo.test ? `${owner || "your contact email (not set: add it in Settings first)"} (a test: nothing goes to ${contact})` : contact;
  const words = Words.safeParse(memo.body);
  const standing = (words.success && words.data.standing?.trim()) || "";
  const titles = (words.success ? words.data.priorities ?? [] : []).map((p) => p.title?.trim() ?? "").filter(Boolean);
  const page = standing || titles.length
    ? ["Standing: " + (standing || "none"), "Priorities:", ...(titles.length ? titles.map((t, i) => `${i + 1}. ${t}`) : ["None were written."])]
    : ["The memo has no words yet."];
  const preview = [
    `To: ${to}`, `Subject: ${memo.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    ...(link ? [] : [`The link cannot be made: ${NO_LINK_BASE}.`, ""]),
    "On the memo page (not in the mail):", ...page, "",
    "Nothing is mailed until you approve.",
  ].join("\n");
  return { title: `Send the strategy memo to ${clientName}`, preview };
}

/**
 * Puts the mail of a strategy memo up for approval: one approval per memo, in any state (a second call, a racing one, or a call after Logan decided returns the first one), recorded on the memo.
 * The card tolerates a memo with no words yet. Nothing is mailed until Logan approves, and the approval sends nothing for a memo that is not `ready` by then.
 */
export async function proposeStrategyApproval(env: Env, memoId: string): Promise<Approval> {
  const db = env.DB;
  let approval = await existingApproval(db, memoId);
  if (!approval) {
    const memo = await getMemo(db, memoId);
    if (!memo) throw new Error("This strategy memo was not found.");
    const d = await describe(env, memo);
    await createApprovalOnce(db, {
      kind: KIND, title: d.title, preview: d.preview, payload: { memoId } satisfies StrategyMemoApprovalPayload, record_type: "business", record_id: memo.businessId, drafted_by: "job",
    }, "memoId", memoId);
    approval = await existingApproval(db, memoId); // two callers at once: the earliest approval stands
  }
  if (!approval) throw new Error("Could not make the approval for the strategy memo.");
  await setMemoLinks(db, memoId, { approvalId: approval.id });
  return approval;
}

const NOT_READY: Record<Exclude<StrategyMemo["status"], "ready">, string> = {
  collecting: "the memo is not ready yet",
  sent: "the memo was already sent",
  revoked: "the memo was taken back (revoked)",
  cancelled: "the memo was cancelled",
};

registerHandler({
  kind: KIND,
  label: "Send strategy memo",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is read again at approval, because days may have passed: only the memo id is trusted from the payload. A mail that already went out under this approval only finishes what comes after it (logs
   * once). A memo that is no longer `ready`, or a business that is no longer a client, gets nothing, and the timeline says why (those cannot clear up, so that approval is used up). What can clear up throws,
   * so the approval goes back to pending and is approved again once it does: a billing hold, a link base that is not usable, a mailbox that cannot send, a contact with no email and a blocked address. Only
   * after all of those does the memo become `sent`, and then ONE mail goes with the approval id as the once-only key; if the send fails the memo is `ready` again. A test memo goes to the owner alone, with
   * "[Test] " on the subject.
   */
  async execute(env: Env, p: StrategyMemoApprovalPayload, a: Approval) {
    const db = env.DB;
    const memo = await getMemo(db, p.memoId);
    if (!memo) throw new Error("This strategy memo was not found.");
    const mailed = await getByApproval(db, a.id);
    const done = async (to: string) => { await logActivityOnce(db, memo.businessId, "strategy_sent", `Strategy memo sent to ${to}${memo.test ? " (test)" : ""}`); };
    if (mailed?.status === "sent") { await markMemoSent(db, memo.id, mailed.sent_at ?? getMailDeps().now().toISOString()); await done(mailed.counterpart); return; } // an earlier run mailed it and something after the mail failed

    const skip = async (why: string) => { await logActivityOnce(db, memo.businessId, "note", `Strategy memo not sent: ${why}, so nothing was mailed`); };
    if (memo.status !== "ready") { await skip(NOT_READY[memo.status]); return; }
    if (!memo.test && !(await isClient(db, memo.businessId))) { await skip("the business is no longer a client"); return; }
    if (!memo.test && (await isOnHold(db, memo.businessId))) throw new Error("This client is on a billing hold, so the memo was not mailed. Approve it again once the hold is lifted.");
    const link = strategyLink(env, memo.token);
    if (!link) throw new Error(`The memo was not mailed: ${NO_LINK_BASE}. Approve it again once that is fixed.`);

    const settings = await getSettings(db);
    const mailbox = await mainMailboxProblem(env);
    if (mailbox) throw new Error(`The main mailbox cannot send: ${mailbox}`);
    const who = await invoiceRecipient(env, { documentId: null, projectId: null, businessId: memo.businessId });
    const owner = settings.contact_email.trim();
    if (memo.test && !owner) throw new Error("Add your contact email in Settings first: a test memo goes to it.");
    if (!memo.test) {
      // The client has paid before, so the gate's "existing client" rule does not apply; a do-not-contact or suppression hit still blocks.
      const conflict = await checkConflict(db, { email: who.to, businessId: memo.businessId });
      if (conflict.blocked && conflict.source !== "client") throw new Error(`Blocked: ${conflict.reason}`);
    }

    const facts = MemoFacts.safeParse(memo.facts);
    const mail = renderStrategyMail({ clientName: (facts.success && facts.data.clientName) || who.clientName, contactName: who.contactName, yourName: signOff(settings), link });
    const to = memo.test ? owner : who.to;
    // Sent first, so a second approval (or a racing one) finds it taken and mails nothing.
    if (!(await markMemoSent(db, memo.id, getMailDeps().now().toISOString()))) return;
    try {
      await sendEmail(env, {
        mailbox: "main", to, subject: `${memo.test ? "[Test] " : ""}${mail.subject}`, body: mail.body, includeFooter: false, ...(memo.test ? {} : { businessId: memo.businessId }),
      }, { approvalId: a.id, skipLimits: true });
    } catch (e) {
      if ((await getByApproval(db, a.id))?.status !== "sent") await unmarkMemoSent(db, memo.id).catch(() => { /* the memo stays `sent`: the safe side */ });
      throw e;
    }
    await done(to);
  },
});
