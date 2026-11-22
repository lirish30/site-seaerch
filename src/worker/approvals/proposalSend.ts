import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import { createApproval, toApproval, type Approval } from "../db/approvals";
import { logActivity } from "../db/activity";
import { DealMoveError, getDeal, moveDeal } from "../db/deals";
import { getDocument, type Document } from "../db/documents";
import { getSettings } from "../db/settings";
import { dollars } from "../../client/packagesView";
import { capacityWarning } from "../capacity/compute";
import { clientBase, renderProposalMail } from "../documents/mail";
import { mailProposalLink, sealProposal, sendProblems } from "../documents/service";
import type { ProposalContent } from "../documents/proposal";

const Payload = z.object({ documentId: z.string().min(1) });
export type ProposalSendPayload = z.infer<typeof Payload>;

const DUE = { signing: "at signing", design_approved: "when the design is approved", site_finished: "when the site is finished" } as const;
const STARTS = { signing: "from signing", launch: "from launch", kickoff: "from kickoff" } as const;

/** The payment schedule as the client will read it, one line each. Every figure is the schedule's own. */
function scheduleLines(c: ProposalContent): string[] {
  const s = c.schedule;
  return [
    ...s.milestones.map((m) => `${m.label}: ${dollars(m.amountCents)}, due ${DUE[m.dueOn]}`),
    ...s.recurring.map((r) => `${r.name}: ${dollars(r.monthlyCents)} a month, ${STARTS[r.startsOn]}${r.termMonths === null ? "" : ` for ${r.termMonths} months`}${r.firstMonthPrepaid ? " (first month paid at signing)" : ""}`),
    `Deposit due at signing: ${dollars(s.depositCents)}`,
  ];
}

/**
 * Puts a draft proposal up for approval: the mail the client will get, the packages and schedule, and the countersignature the approval makes. The
 * approval IS Logan's signature (the same hash as the content that goes out), so one waiting approval per document: a second call returns the first.
 * A later edit to the draft withdraws it (`draftProposal`), so what he approves is what is sent.
 */
export async function createSendApproval(env: Env, doc: Document): Promise<Approval> {
  if (doc.status !== "draft") throw new Error(`this proposal is ${doc.status}, not a draft`);
  const db = env.DB;
  const waiting = () => db.prepare(
    `SELECT * FROM approvals WHERE kind = 'proposal.send' AND status = 'pending' AND json_extract(payload, '$.documentId') = ? ORDER BY created_at, id`,
  ).bind(doc.id).all<Parameters<typeof toApproval>[0]>().then((r) => r.results.map(toApproval));
  const first = (await waiting())[0];
  if (first) return first;

  const settings = await getSettings(db);
  const c = doc.content;
  const base = clientBase(env);
  const mail = renderProposalMail(c, `${base ?? "(set CLIENT_LINK_BASE first)"}/p/(the link is made when you approve)`, settings);
  // Capacity only warns: a full week never stops a proposal from going out, and neither does a failed read of it.
  const warning = await capacityWarning(db, new Date(), 0).catch((e) => { console.error("proposal send: capacity warning failed", e); return null; });
  const preview = [
    `To: ${c.header.contactName} <${c.header.contactEmail}>`, `Subject: ${mail.subject}`, "", mail.body, "",
    `Proposal ${c.header.reference}, version ${doc.version}, option ${doc.optionId.toUpperCase()}`,
    ...c.packages.map((p) => `  ${p.name}: ${p.priceLine}`), "Payment schedule:", ...scheduleLines(c).map((l) => `  ${l}`), "",
    `Approving countersigned as ${settings.your_name.trim()} <${settings.contact_email.trim()}>.`,
    ...(warning ? ["", warning] : []),
  ].join("\n");
  const a = await createApproval(db, {
    kind: "proposal.send", title: `Send the proposal to ${c.header.clientName}`, preview, payload: { documentId: doc.id } satisfies ProposalSendPayload,
    record_type: "deal", record_id: doc.dealId, drafted_by: "logan",
  });
  // Two callers at once: the earliest approval stands, the other is dropped.
  const winner = (await waiting())[0];
  if (winner && winner.id !== a.id) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    return winner;
  }
  return a;
}

registerHandler({
  kind: "proposal.send",
  label: "Send proposal",
  parse: (p) => Payload.parse(p),
  /**
   * Everything is checked again at approval, because days may have passed: the lawyer's review, the mailbox, the contact and lead, the deal, the frozen
   * prices (`sendProblems`). Then, in order and each step safe to repeat: stamp the document sent (a retry of the same approval finds it already sent and
   * keeps its token and hash), mail the link with the approval id as the once-only key, move the deal to proposal_sent, log it.
   */
  async execute(env: Env, p: ProposalSendPayload, a: Approval) {
    const doc = await getDocument(env.DB, p.documentId);
    if (!doc) throw new Error("this proposal was not found");
    const problems = await sendProblems(env, doc, { approvalId: a.id });
    if (problems.length) throw new Error(problems[0]);
    const settings = await getSettings(env.DB);
    const sent = doc.status === "draft" ? await sealProposal(env, doc, { now: new Date(), approvalId: a.id, test: false, settings }) : doc;

    await mailProposalLink(env, sent, settings, a.id);

    const deal = await getDeal(env.DB, sent.dealId);
    if (deal && deal.stage !== "proposal_sent") {
      try { await moveDeal(env.DB, deal.id, "proposal_sent"); }
      catch (e) { if (!(e instanceof DealMoveError)) throw e; throw new Error(`the proposal was mailed but the deal could not move: ${e.message}`); }
    }
    const h = sent.content.header;
    await logActivity(env.DB, sent.businessId, "proposal_sent", `${h.reference} v${sent.version} option ${sent.optionId.toUpperCase()} to ${h.contactEmail}, expires ${sent.expiresAt?.slice(0, 10)}`);
  },
});
