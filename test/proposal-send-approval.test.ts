import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { createSendApproval } from "../src/worker/approvals/proposalSend";
import { listActivity } from "../src/worker/db/activity";
import { updateLead } from "../src/worker/db/businesses";
import { getDeal, moveDeal } from "../src/worker/db/deals";
import { getDocument, signaturesFor, voidDocument } from "../src/worker/db/documents";
import { addDoNotContact, removeDoNotContact } from "../src/worker/db/doNotContact";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { canonicalJson, sha256Hex } from "../src/worker/documents/hash";
import { draftProposal } from "../src/worker/documents/service";
import { setMailDeps } from "../src/worker/mail/deps";
import { readyToSend, seedProposalDeal } from "./fixtures/documents";

const NOW = new Date("2026-12-01T17:00:00.000Z");
let mail: Awaited<ReturnType<typeof readyToSend>>;
beforeEach(async () => { mail = await readyToSend(); });
afterEach(() => setMailDeps(null));

async function ready(o: Parameters<typeof seedProposalDeal>[0] = {}, test = false) {
  const s = await seedProposalDeal(o);
  const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: { scopeNotes: "A new site." }, test }, NOW);
  return { ...s, doc };
}
const row = (id: string) => env.DB.prepare(`SELECT status, error FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>();

describe("proposal.send", () => {
  it("createSendApproval previews the mail, the schedule and the countersignature, once per document", async () => {
    const { doc } = await ready();
    const a = await createSendApproval(env, doc);
    expect(a).toMatchObject({ kind: "proposal.send", title: "Send the proposal to Ace Plumbing", payload: { documentId: doc.id }, record_type: "deal", record_id: doc.dealId, drafted_by: "logan", status: "pending" });
    expect(a.preview).toContain("Hi Pat,");
    expect(a.preview).toContain("$1,998.50");
    expect(a.preview).toContain("Starter Site");
    expect(a.preview).toContain("countersigned as Logan Irish");
    const again = await createSendApproval(env, doc);
    expect(again.id).toBe(a.id);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'proposal.send' AND status = 'pending' AND json_extract(payload, '$.documentId') = ?`).bind(doc.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("execute refuses before the legal review is recorded", async () => {
    const { doc } = await ready();
    const a = await createSendApproval(env, doc);
    await saveSettings(env.DB, { documents_config: "{}" });
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/Oregon lawyer/);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
    expect(mail.sent).toEqual([]);
  });

  it("execute refuses when the main mailbox is not set up", async () => {
    const { doc } = await ready();
    const a = await createSendApproval(env, doc);
    await saveMailbox(env.DB, "main", { enabled: 0 });
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not enabled/);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
    expect(mail.sent).toEqual([]);
  });

  it("execute refuses a do-not-contact contact", async () => {
    const { doc } = await ready();
    const a = await createSendApproval(env, doc);
    const listed = await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out" });
    try {
      const r = await approve(env, a.id);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/do-not-contact/);
    } finally { await removeDoNotContact(env.DB, listed.id); }
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
    expect(mail.sent).toEqual([]);
  });

  it("execute refuses a lead that is already won", async () => {
    const { doc, businessId } = await ready();
    const a = await createSendApproval(env, doc);
    await updateLead(env.DB, businessId, { leadStatus: "won" });
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/existing client/);
    expect(mail.sent).toEqual([]);
  });

  it("a deal marked lost after the draft refuses to send", async () => {
    const { doc, dealId } = await ready();
    const a = await createSendApproval(env, doc);
    await moveDeal(env.DB, dealId, "lost", { lostReason: "went with a cousin" });
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/lost/);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
    expect(mail.sent).toEqual([]);
  });

  it("a test document is never sent through the approval", async () => {
    const { doc } = await ready({}, true);
    const a = await createSendApproval(env, doc);
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Send a test only/);
    expect(mail.sent).toEqual([]);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
  });

  it("a voided document cannot be approved afterwards", async () => {
    const { doc } = await ready();
    const a = await createSendApproval(env, doc);
    await voidDocument(env.DB, doc.id, "changed my mind");
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not a draft/);
    expect(mail.sent).toEqual([]);
  });

  it("execute freezes content, stores the hash, signs as provider, mails the link, and moves the deal to proposal_sent", async () => {
    const { doc, dealId, businessId } = await ready();
    const a = await createSendApproval(env, doc);
    expect(await approve(env, a.id)).toEqual({ ok: true });

    const sent = (await getDocument(env.DB, doc.id))!;
    expect(sent).toMatchObject({ status: "sent", approvalId: a.id, test: false });
    expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.content.header.sentOn).toBe(sent.sentAt);
    expect(sent.content.header.expiresOn).toBe(sent.expiresAt);
    expect(Date.parse(sent.expiresAt!) - Date.parse(sent.sentAt!)).toBe(30 * 86_400_000);
    expect(sent.contentSha256).toBe(await sha256Hex(canonicalJson(sent.content)));
    expect(sent.content.scopeNotes).toBe("A new site.");

    const sigs = await signaturesFor(env.DB, doc.id);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ role: "provider", signerName: "Logan Irish", signerEmail: "logan@siteline.test", consentText: "Approved for sending", contentSha256: sent.contentSha256 });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@acme.test" });
    expect(mail.sent[0].from.email).toBe("logan@main.test");
    expect(mail.sent[0].text).toContain(`https://clients.hellositeline.test/p/${sent.token}`);
    expect(mail.sent[0].text).not.toContain("workers.dev");
    const msg = await env.DB.prepare(`SELECT approval_id, mailbox_key, status FROM messages WHERE approval_id = ?`).bind(a.id).first();
    expect(msg).toMatchObject({ approval_id: a.id, mailbox_key: "main", status: "sent" });

    expect((await getDeal(env.DB, dealId))!.stage).toBe("proposal_sent");
    const log = (await listActivity(env.DB, businessId)).filter((x) => x.kind === "proposal_sent");
    expect(log).toHaveLength(1);
    expect(log[0].detail).toContain("SL-");
  });

  it("a retried approval does not mail twice", async () => {
    const { doc, dealId } = await ready();
    const a = await createSendApproval(env, doc);
    mail.failures.push(new Error("smtp down"));
    const first = await approve(env, a.id);
    expect(first.ok).toBe(false);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    // The document is already sent (the link is live); the mail did not go.
    const afterFail = (await getDocument(env.DB, doc.id))!;
    expect(afterFail.status).toBe("sent");
    expect((await getDeal(env.DB, dealId))!.stage).toBe("recommended");
    expect(mail.sent).toEqual([]);

    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    const again = (await getDocument(env.DB, doc.id))!;
    expect(again.token).toBe(afterFail.token);
    expect(again.contentSha256).toBe(afterFail.contentSha256);
    expect(await signaturesFor(env.DB, doc.id)).toHaveLength(1);
    expect((await getDeal(env.DB, dealId))!.stage).toBe("proposal_sent");

    // Running the handler again after success (a duplicate delivery) mails nothing more.
    const { getHandler } = await import("../src/worker/approvals/registry");
    await getHandler("proposal.send")!.execute(env, { documentId: doc.id }, { ...a, status: "approved" });
    expect(mail.sent).toHaveLength(1);
  });

  it("a retry after the mail went out but the deal did not move finishes the move", async () => {
    const { doc, dealId } = await ready();
    const a = await createSendApproval(env, doc);
    expect(await approve(env, a.id)).toEqual({ ok: true });
    await env.DB.prepare(`UPDATE deals SET stage = 'recommended' WHERE id = ?`).bind(dealId).run();
    const { getHandler } = await import("../src/worker/approvals/registry");
    await getHandler("proposal.send")!.execute(env, { documentId: doc.id }, { ...a, status: "approved" });
    expect(mail.sent).toHaveLength(1);
    expect((await getDeal(env.DB, dealId))!.stage).toBe("proposal_sent");
  });

  it("a deal already at proposal_sent (a new version after a void) is sent and stays there", async () => {
    const { doc, dealId } = await ready({ stage: "proposal_sent" });
    const a = await createSendApproval(env, doc);
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect((await getDeal(env.DB, dealId))!.stage).toBe("proposal_sent");
  });
});
