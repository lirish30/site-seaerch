import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { DocumentStateError, getDocument, listForDeal, voidDocument } from "../src/worker/db/documents";
import { moveDeal } from "../src/worker/db/deals";
import { savePackage } from "../src/worker/db/packages";
import { updateLead } from "../src/worker/db/businesses";
import { saveSettings } from "../src/worker/db/settings";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { setMailDeps } from "../src/worker/mail/deps";
import { addDoNotContact, removeDoNotContact } from "../src/worker/db/doNotContact";
import { ProposalError } from "../src/worker/documents/proposal";
import { draftProposal, sendProblems } from "../src/worker/documents/service";
import { createSendApproval } from "../src/worker/approvals/proposalSend";
import { readyToSend, seedProposalDeal, sendDraft } from "./fixtures/documents";

const NOW = new Date("2026-12-01T17:00:00.000Z");
beforeEach(async () => { await readyToSend(); });
afterEach(() => setMailDeps(null));

describe("draftProposal", () => {
  it("draftProposal defaults the contact from the discovery booking", async () => {
    const s = await seedProposalDeal();
    const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: { scopeNotes: "A new site." } }, NOW);
    expect(doc).toMatchObject({ status: "draft", version: 1, optionId: "b", test: false, dealId: s.dealId, businessId: s.businessId });
    expect(doc.content.header).toMatchObject({
      clientName: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@acme.test", providerName: "Logan Irish", providerBusiness: "Siteline",
      providerEmail: "logan@siteline.test", version: 1, preparedOn: NOW.toISOString(),
    });
    expect(doc.content.packages.map((p) => [p.key, p.version])).toEqual([["starter_site", 1], ["care", 1]]);
    expect(doc.content.packages[0].includes.length).toBeGreaterThan(0);
    expect(doc.content.scopeNotes).toBe("A new site.");
    expect(doc.content.clauses.map((c) => c.id)).toContain("care_terms");
  });

  it("an explicit contact wins", async () => {
    const s = await seedProposalDeal();
    const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: {}, contact: { name: "Sam Rivera", email: "sam@ace.test" } }, NOW);
    expect(doc.content.header).toMatchObject({ contactName: "Sam Rivera", contactEmail: "sam@ace.test" });
  });

  it("a deal with no booking and no contact is refused with a message about the missing email", async () => {
    const s = await seedProposalDeal({ booking: false });
    await expect(draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toThrow(/no email/i);
    const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: {}, contact: { name: "Sam", email: "sam@ace.test" } }, NOW);
    expect(doc.content.header.contactEmail).toBe("sam@ace.test");
  });

  it("a deal with no snapshot item for an option key is refused", async () => {
    const s = await seedProposalDeal();
    const snap = s.deal.priceSnapshot.filter((p) => p.key !== "care");
    await env.DB.prepare(`UPDATE deals SET price_snapshot = ? WHERE id = ?`).bind(JSON.stringify(snap), s.dealId).run();
    await expect(draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toBeInstanceOf(ProposalError);
    await expect(draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toThrow(/care has no frozen price/);
    expect(await listForDeal(env.DB, s.dealId)).toEqual([]);
  });

  it("an unknown deal is refused", async () => {
    await expect(draftProposal(env, "nope", { optionId: "b", edits: {} }, NOW)).rejects.toBeInstanceOf(ProposalError);
  });

  it("editing after a send is refused until the sent version is voided", async () => {
    const s = await seedProposalDeal();
    const draft = await draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW);
    const sent = await sendDraft(draft.id, draft.content);
    await expect(draftProposal(env, s.dealId, { optionId: "b", edits: { scopeNotes: "sneaky" } }, NOW)).rejects.toBeInstanceOf(DocumentStateError);
    expect((await getDocument(env.DB, draft.id))!.content.scopeNotes).toBe("");
    await voidDocument(env.DB, sent.doc.id, "wrong option");
    const next = await draftProposal(env, s.dealId, { optionId: "c", edits: {} }, NOW);
    expect(next).toMatchObject({ version: 2, optionId: "c", status: "draft" });
    expect(next.content.header.version).toBe(2);
  });

  it("a catalog price change after recap does not change the draft", async () => {
    const s = await seedProposalDeal();
    const changed = await savePackage(env.DB, "starter_site", { priceCents: 499700 });
    try {
      const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW);
      expect(doc.content.packages[0]).toMatchObject({ key: "starter_site", version: 1, priceLine: "from $3,997" });
      expect(doc.content.schedule.depositCents).toBe(199850);
    } finally { await env.DB.prepare(`DELETE FROM packages WHERE key = 'starter_site' AND version = ?`).bind(changed.version).run(); }
  });

  it("a replaced draft keeps its version, and header.version always equals the row's", async () => {
    const s = await seedProposalDeal();
    const first = await draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW);
    const second = await draftProposal(env, s.dealId, { optionId: "c", edits: {} }, NOW);
    expect(await listForDeal(env.DB, s.dealId)).toHaveLength(1);
    expect(second).toMatchObject({ version: 1, optionId: "c" });
    expect(second.content.header.version).toBe(second.version);
    expect(first.version).toBe(1);
    // A test draft is a different kind of document, so it is rebuilt (replaced), and still takes the same number.
    const test = await draftProposal(env, s.dealId, { optionId: "c", edits: {}, test: true }, NOW);
    expect(await listForDeal(env.DB, s.dealId)).toHaveLength(1);
    expect(test).toMatchObject({ version: 1, test: true });
    expect(test.content.header.version).toBe(1);
  });
});

describe("a draft that changes after it was sent for approval", () => {
  it("editing it withdraws the waiting approval, so what is approved is what is sent", async () => {
    const s = await seedProposalDeal();
    const draft = await draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW);
    const a = await createSendApproval(env, draft);
    await draftProposal(env, s.dealId, { optionId: "b", edits: { scopeNotes: "Changed after the approval was made." } }, NOW);
    expect(await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(a.id).first()).toMatchObject({ status: "rejected" });
    // Replacing the draft with a test copy (a different kind of document) withdraws it as well, and so does voiding.
    const fresh = await createSendApproval(env, (await getDocument(env.DB, draft.id))!);
    expect(fresh.id).not.toBe(a.id);
    expect(fresh.preview).toContain("Starter Site");
    await draftProposal(env, s.dealId, { optionId: "b", edits: {}, test: true }, NOW);
    expect(await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(fresh.id).first()).toMatchObject({ status: "rejected" });
  });
});

describe("sendProblems", () => {
  const draft = async (o: Parameters<typeof seedProposalDeal>[0] = {}) => {
    const s = await seedProposalDeal(o);
    return { ...s, doc: await draftProposal(env, s.dealId, { optionId: "b", edits: {} }, NOW) };
  };

  it("a clean draft has no problems", async () => {
    const { doc } = await draft();
    expect(await sendProblems(env, doc)).toEqual([]);
  });

  it("the legal gate always applies", async () => {
    const { doc } = await draft();
    await saveSettings(env.DB, { documents_config: "{}" });
    expect((await sendProblems(env, doc)).join(" ")).toMatch(/Oregon lawyer/);
  });

  it("a blank signer name or contact email is a problem, so the countersignature is never blank", async () => {
    const { doc } = await draft();
    await saveSettings(env.DB, { your_name: "  " });
    expect((await sendProblems(env, doc)).join(" ")).toMatch(/Add your name/);
    await saveSettings(env.DB, { your_name: "Logan Irish", contact_email: " " });
    expect((await sendProblems(env, doc)).join(" ")).toMatch(/Add your contact email/);
    await saveSettings(env.DB, { contact_email: "logan@siteline.test" });
    expect(await sendProblems(env, doc)).toEqual([]);
  });

  it("a test document is always refused", async () => {
    const s = await seedProposalDeal();
    const doc = await draftProposal(env, s.dealId, { optionId: "b", edits: {}, test: true }, NOW);
    expect(await sendProblems(env, doc)).toContain("test documents go out with Send a test only");
  });

  it("a mailbox that is not set up is a problem", async () => {
    const { doc } = await draft();
    await saveMailbox(env.DB, "main", { enabled: 0 });
    expect((await sendProblems(env, doc)).join(" ")).toMatch(/not enabled/);
  });

  it("a missing or non-https client link base is a problem", async () => {
    const { doc } = await draft();
    expect((await sendProblems({ ...env, CLIENT_LINK_BASE: undefined } as Env, doc)).join(" ")).toMatch(/CLIENT_LINK_BASE/);
    expect((await sendProblems({ ...env, CLIENT_LINK_BASE: "http://clients.example.com" } as Env, doc)).join(" ")).toMatch(/CLIENT_LINK_BASE/);
    expect((await sendProblems({ ...env, CLIENT_LINK_BASE: "https://app.workers.dev" } as Env, doc)).join(" ")).toMatch(/CLIENT_LINK_BASE/);
    expect((await sendProblems({ ...env, CLIENT_LINK_BASE: env.OUTREACH_LINK_BASE } as Env, doc)).join(" ")).toMatch(/CLIENT_LINK_BASE/);
  });

  it("a do-not-contact contact and a lead that is already won are problems", async () => {
    const a = await draft();
    const listed = await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out" });
    expect((await sendProblems(env, a.doc)).join(" ")).toMatch(/do-not-contact/);
    await removeDoNotContact(env.DB, listed.id);
    const b = await draft();
    await updateLead(env.DB, b.businessId, { leadStatus: "won" });
    expect((await sendProblems(env, b.doc)).join(" ")).toMatch(/existing client/);
  });

  it("a deal that is lost or won, or a document that is not a draft, is a problem", async () => {
    const a = await draft();
    await moveDeal(env.DB, a.dealId, "lost", { lostReason: "went elsewhere" });
    expect((await sendProblems(env, a.doc)).join(" ")).toMatch(/lost/);
    const b = await draft();
    const sent = await sendDraft(b.doc.id, b.doc.content);
    expect((await sendProblems(env, sent.doc)).join(" ")).toMatch(/not a draft/);
  });

  it("a frozen price that differs from its catalog version is refused as corrupt data", async () => {
    const { doc } = await draft();
    const bump = (n: number) => env.DB.prepare(`UPDATE packages SET price_cents = price_cents + ? WHERE key = 'starter_site' AND version = (SELECT MAX(version) FROM packages WHERE key = 'starter_site')`).bind(n).run();
    await bump(100);
    try { expect((await sendProblems(env, doc)).join(" ")).toMatch(/Starter Site.*differs from its catalog version/); }
    finally { await bump(-100); }
  });
});
