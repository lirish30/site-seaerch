import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  DocumentStateError, countViews, createDraft, nextDraftVersion, expireDue, getByToken, getDocument, listForDeal, markSent, recordView, setPaid, setPdf, signDocument, signaturesFor,
  updateDraft, voidDocument,
} from "../src/worker/db/documents";
import { newClientToken } from "../src/worker/documents/token";
import { clientSig, EXPIRES_AT, proposal, seedDeal, sendDraft } from "./fixtures/documents";

const draftFor = async (o: { optionId?: "a" | "b" | "c" } = {}) => {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: o.optionId ?? "b", content: proposal({ optionId: o.optionId }) });
  return { ...s, doc };
};
const openDoc = async (o: { expiresAt?: string } = {}) => {
  const s = await draftFor();
  const sent = await sendDraft(s.doc.id, s.doc.content, o);
  return { ...s, ...sent };
};
const NOW = "2026-12-02T09:00:00.000Z";

describe("createDraft", () => {
  it("createDraft numbers versions per deal", async () => {
    const s = await seedDeal();
    const first = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    expect(first).toMatchObject({ version: 1, status: "draft", test: false, optionId: "b", token: null, contentSha256: null, sentAt: null, signedAt: null, paidAt: null, pdfKey: null });
    expect(first.content).toEqual(proposal());
    await voidDocument(env.DB, first.id, "changed my mind");
    const second = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "c", content: proposal({ optionId: "c" }), test: true });
    expect(second).toMatchObject({ version: 2, status: "draft", test: true, optionId: "c" });
    // Another deal starts at 1 again.
    const other = await draftFor();
    expect(other.doc.version).toBe(1);
  });

  it("createDraft replaces an existing draft", async () => {
    const s = await seedDeal();
    const a = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "a", content: proposal({ optionId: "a" }) });
    const b = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "c", content: proposal({ optionId: "c" }) });
    expect(b.id).not.toBe(a.id);
    expect(await getDocument(env.DB, a.id)).toBeNull();
    const all = await listForDeal(env.DB, s.dealId);
    expect(all.map((d) => d.id)).toEqual([b.id]);
    expect(all[0].optionId).toBe("c");
  });

  it("createDraft refuses while a sent document is open", async () => {
    const s = await openDoc();
    await expect(createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() })).rejects.toBeInstanceOf(DocumentStateError);
    await recordView(env.DB, s.doc.id, { now: NOW, userAgent: null });
    await expect(createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() })).rejects.toBeInstanceOf(DocumentStateError);
    // The sent document is untouched, and a signed one blocks too.
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("viewed");
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), NOW)).toBe("signed");
    await expect(createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() })).rejects.toBeInstanceOf(DocumentStateError);
    expect(await listForDeal(env.DB, s.dealId)).toHaveLength(1);
  });

  it("a replaced draft keeps its version number, so none is skipped", async () => {
    const s = await seedDeal();
    expect(await nextDraftVersion(env.DB, s.dealId)).toBe(1);
    const first = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "a", content: proposal({ optionId: "a" }) });
    expect(first.version).toBe(1);
    expect(await nextDraftVersion(env.DB, s.dealId)).toBe(1);
    const second = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "c", content: proposal({ optionId: "c" }) });
    expect(second.version).toBe(1);
    await voidDocument(env.DB, second.id, "start over");
    expect(await nextDraftVersion(env.DB, s.dealId)).toBe(2);
    const third = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal({ version: 2 }) });
    expect(third.version).toBe(2);
    expect(third.content.header.version).toBe(third.version);
  });

  it("a void document does not block the next draft", async () => {
    const s = await openDoc();
    await voidDocument(env.DB, s.doc.id, "wrong option");
    const next = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "a", content: proposal({ version: 2, optionId: "a" }) });
    expect(next.version).toBe(2);
    expect((await listForDeal(env.DB, s.dealId)).map((d) => [d.version, d.status])).toEqual([[2, "draft"], [1, "void"]]);
  });
});

describe("updateDraft", () => {
  it("a draft's content and option can change", async () => {
    const { doc } = await draftFor();
    const updated = await updateDraft(env.DB, doc.id, proposal({ optionId: "c", scopeNotes: "More pages." }));
    expect(updated).toMatchObject({ id: doc.id, optionId: "c", status: "draft" });
    expect(updated.content.scopeNotes).toBe("More pages.");
    expect(updated.updatedAt >= doc.updatedAt).toBe(true);
  });

  it("a sent document cannot be edited", async () => {
    const s = await openDoc();
    await expect(updateDraft(env.DB, s.doc.id, proposal({ scopeNotes: "sneaky" }))).rejects.toBeInstanceOf(DocumentStateError);
    expect((await getDocument(env.DB, s.doc.id))!.content.scopeNotes).toBe("");
    await expect(updateDraft(env.DB, "nope", proposal())).rejects.toBeInstanceOf(DocumentStateError);
  });
});

describe("markSent", () => {
  it("markSent freezes content and inserts the provider signature in one step", async () => {
    const { doc } = await draftFor();
    const token = newClientToken();
    expect(token).toHaveLength(43);
    const frozen = proposal({ scopeNotes: "frozen" });
    const sent = await markSent(env.DB, doc.id, {
      token, content: frozen, contentSha256: "a".repeat(64), sentAt: "2026-12-01T17:00:00.000Z", expiresAt: EXPIRES_AT, approvalId: "appr1",
      provider: { signerName: "Pat Provider", signerEmail: "hello@siteline.test", signedAt: "2026-12-01T17:00:00.000Z", ip: null, userAgent: null, consentText: "c", consentVersion: 1, contentSha256: "a".repeat(64) },
    });
    expect(sent).toMatchObject({ id: doc.id, status: "sent", token, contentSha256: "a".repeat(64), sentAt: "2026-12-01T17:00:00.000Z", expiresAt: EXPIRES_AT, approvalId: "appr1" });
    expect(sent.content.scopeNotes).toBe("frozen");
    const sigs = await signaturesFor(env.DB, doc.id);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ documentId: doc.id, role: "provider", signerName: "Pat Provider", contentSha256: "a".repeat(64), consentVersion: 1 });
    expect((await getByToken(env.DB, token))!.id).toBe(doc.id);
    expect(await getByToken(env.DB, newClientToken())).toBeNull();
  });

  it("markSent with test marks the document a test and a plain send leaves it as it was", async () => {
    const { doc } = await draftFor();
    const sent = await markSent(env.DB, doc.id, {
      token: newClientToken(), content: doc.content, contentSha256: "b".repeat(64), sentAt: "2026-12-01T17:00:00.000Z", expiresAt: EXPIRES_AT, approvalId: null, test: true,
      provider: { signerName: "Pat Provider", signerEmail: "hello@siteline.test", signedAt: "2026-12-01T17:00:00.000Z", ip: null, userAgent: null, consentText: "c", consentVersion: 1, contentSha256: "b".repeat(64) },
    });
    expect(sent.test).toBe(true);
    const plain = await openDoc();
    expect(plain.doc.test).toBe(false);
  });

  it("markSent twice with the same approval id returns the same document", async () => {
    const { doc } = await draftFor();
    const first = await sendDraft(doc.id, doc.content, { approvalId: "appr1" });
    const again = await sendDraft(doc.id, doc.content, { approvalId: "appr1" });
    expect(again.doc).toEqual(first.doc);
    expect(await signaturesFor(env.DB, doc.id)).toHaveLength(1);
  });

  it("markSent refuses a document that is not a draft", async () => {
    const s = await openDoc();
    await expect(sendDraft(s.doc.id, s.doc.content, { approvalId: "another" })).rejects.toBeInstanceOf(DocumentStateError);
    await expect(sendDraft(s.doc.id, s.doc.content)).rejects.toBeInstanceOf(DocumentStateError);
    expect((await getDocument(env.DB, s.doc.id))!.token).toBe(s.doc.token);
    expect(await signaturesFor(env.DB, s.doc.id)).toHaveLength(1);
  });
});

describe("recordView", () => {
  it("recordView moves sent to viewed once and rate-limits rows", async () => {
    const s = await openDoc();
    await recordView(env.DB, s.doc.id, { now: "2026-12-02T09:00:00.000Z", userAgent: "UA1" });
    let doc = (await getDocument(env.DB, s.doc.id))!;
    expect(doc).toMatchObject({ status: "viewed", firstViewedAt: "2026-12-02T09:00:00.000Z" });
    await recordView(env.DB, s.doc.id, { now: "2026-12-02T09:05:00.000Z", userAgent: "UA1" });
    expect(await countViews(env.DB, s.doc.id)).toBe(1);
    await recordView(env.DB, s.doc.id, { now: "2026-12-02T09:10:00.001Z", userAgent: null });
    expect(await countViews(env.DB, s.doc.id)).toBe(2);
    doc = (await getDocument(env.DB, s.doc.id))!;
    expect(doc).toMatchObject({ status: "viewed", firstViewedAt: "2026-12-02T09:00:00.000Z" });
  });

  it("a draft has no views", async () => {
    const { doc } = await draftFor();
    await recordView(env.DB, doc.id, { now: NOW, userAgent: null });
    expect(await countViews(env.DB, doc.id)).toBe(0);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
  });
});

describe("signDocument", () => {
  it("signDocument stores the client signature and moves to signed", async () => {
    const s = await openDoc();
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), NOW)).toBe("signed");
    const doc = (await getDocument(env.DB, s.doc.id))!;
    expect(doc).toMatchObject({ status: "signed", signedAt: "2026-12-02T09:00:00.000Z" });
    const sigs = await signaturesFor(env.DB, s.doc.id);
    expect(sigs.map((x) => x.role).sort()).toEqual(["client", "provider"]);
    expect(sigs.find((x) => x.role === "client")).toMatchObject({ signerName: "Pat Jones", ip: "203.0.113.9", userAgent: "TestBrowser/1.0", contentSha256: s.hash });
    // A second sign is a no-op that says so.
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash, { signedAt: "2026-12-02T10:00:00.000Z" }), "2026-12-02T10:00:00.000Z")).toBe("already_signed");
    expect((await signaturesFor(env.DB, s.doc.id)).filter((x) => x.role === "client")).toHaveLength(1);
    expect((await getDocument(env.DB, s.doc.id))!.signedAt).toBe("2026-12-02T09:00:00.000Z");
  });

  it("a viewed document can be signed", async () => {
    const s = await openDoc();
    await recordView(env.DB, s.doc.id, { now: NOW, userAgent: null });
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), NOW)).toBe("signed");
  });

  it("sign with a stale hash is refused", async () => {
    const s = await openDoc();
    expect(await signDocument(env.DB, s.doc.id, clientSig("f".repeat(64)), NOW)).toBe("not_open");
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("sent");
    expect(await signaturesFor(env.DB, s.doc.id)).toHaveLength(1);
  });

  it("sign after expiry is refused", async () => {
    const s = await openDoc({ expiresAt: "2026-12-03T00:00:00.000Z" });
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), "2026-12-03T00:00:00.000Z")).toBe("not_open");
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), "2026-12-04T00:00:00.000Z")).toBe("not_open");
    expect(await signaturesFor(env.DB, s.doc.id)).toHaveLength(1);
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), "2026-12-02T23:59:59.999Z")).toBe("signed");
  });

  it("sign on a void document is refused", async () => {
    const s = await openDoc();
    await voidDocument(env.DB, s.doc.id, "pulled back");
    expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), NOW)).toBe("not_open");
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("void");
  });

  it("sign on a draft or an unknown document is refused", async () => {
    const { doc } = await draftFor();
    expect(await signDocument(env.DB, doc.id, clientSig("a".repeat(64)), NOW)).toBe("not_open");
    expect(await signDocument(env.DB, "nope", clientSig("a".repeat(64)), NOW)).toBe("not_open");
  });

  it("two simultaneous signs leave one signature", async () => {
    const s = await openDoc();
    const results = await Promise.all([
      signDocument(env.DB, s.doc.id, clientSig(s.hash, { signedAt: "2026-12-02T09:00:00.000Z" }), NOW),
      signDocument(env.DB, s.doc.id, clientSig(s.hash, { signedAt: "2026-12-02T09:00:00.001Z" }), NOW),
    ]);
    expect([...results].sort()).toEqual(["already_signed", "signed"]);
    expect((await signaturesFor(env.DB, s.doc.id)).filter((x) => x.role === "client")).toHaveLength(1);
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");
  });
});

describe("voidDocument", () => {
  it("a signed document cannot be voided", async () => {
    const s = await openDoc();
    await signDocument(env.DB, s.doc.id, clientSig(s.hash), NOW);
    await expect(voidDocument(env.DB, s.doc.id, "oops")).rejects.toBeInstanceOf(DocumentStateError);
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");
  });

  it("a draft, a sent and a viewed document can be voided with a reason", async () => {
    const d = await draftFor();
    expect(await voidDocument(env.DB, d.doc.id, "not needed")).toMatchObject({ status: "void", voidReason: "not needed" });
    const sent = await openDoc();
    expect(await voidDocument(env.DB, sent.doc.id, "re-scoped")).toMatchObject({ status: "void", voidReason: "re-scoped" });
    const viewed = await openDoc();
    await recordView(env.DB, viewed.doc.id, { now: NOW, userAgent: null });
    expect((await voidDocument(env.DB, viewed.doc.id, "re-priced")).status).toBe("void");
    await expect(voidDocument(env.DB, "nope", "x")).rejects.toBeInstanceOf(DocumentStateError);
  });
});

describe("expireDue", () => {
  it("expireDue expires only sent and viewed documents past expiresAt", async () => {
    const now = "2026-12-05T00:00:00.000Z", before = "2026-12-04T23:59:59.999Z";
    const sentLate = await openDoc({ expiresAt: "2026-12-10T00:00:00.000Z" });
    const sentAtNow = await openDoc({ expiresAt: now });
    const sentDue = await openDoc({ expiresAt: before });
    const viewedDue = await openDoc({ expiresAt: before });
    await recordView(env.DB, viewedDue.doc.id, { now: NOW, userAgent: null });
    const signedDue = await openDoc({ expiresAt: before });
    await signDocument(env.DB, signedDue.doc.id, clientSig(signedDue.hash), NOW);
    const voidDue = await openDoc({ expiresAt: before });
    await voidDocument(env.DB, voidDue.doc.id, "x");
    const draft = await draftFor();

    expect((await expireDue(env.DB, now)).map((d) => d.id).sort()).toEqual([sentDue.doc.id, viewedDue.doc.id].sort());
    const status = async (id: string) => (await getDocument(env.DB, id))!.status;
    expect(await status(sentDue.doc.id)).toBe("expired");
    expect(await status(viewedDue.doc.id)).toBe("expired");
    // A document expiring exactly at `now` is still open; the next tick expires it.
    expect(await status(sentAtNow.doc.id)).toBe("sent");
    expect(await status(sentLate.doc.id)).toBe("sent");
    expect(await status(signedDue.doc.id)).toBe("signed");
    expect(await status(voidDue.doc.id)).toBe("void");
    expect(await status(draft.doc.id)).toBe("draft");
    expect(await expireDue(env.DB, now)).toEqual([]);
    expect((await expireDue(env.DB, "2026-12-05T00:00:00.001Z")).map((d) => d.id)).toEqual([sentAtNow.doc.id]);
    expect(await status(sentAtNow.doc.id)).toBe("expired");
  });
});

describe("one open document per deal", () => {
  it("only one open document per deal", async () => {
    const s = await seedDeal();
    const insert = (id: string, version: number, status: string) => env.DB.prepare(
      `INSERT INTO documents (id, deal_id, business_id, version, status, option_id, content, created_at, updated_at) VALUES (?,?,?,?,?,'a','{}','t','t')`)
      .bind(id, s.dealId, s.businessId, version, status).run();
    await insert("d1", 1, "draft");
    await expect(insert("d2", 2, "sent")).rejects.toThrow();
    await expect(insert("d3", 3, "viewed")).rejects.toThrow();
    await insert("d4", 4, "signed");
    await insert("d5", 5, "void");
    await insert("d6", 6, "expired");
    await expect(insert("d7", 4, "void")).rejects.toThrow(); // UNIQUE(deal_id, version)
    await expect(insert("d8", 8, "bogus")).rejects.toThrow(); // CHECK on status
  });

  it("a token is unique, and drafts without one do not clash", async () => {
    const a = await draftFor(), b = await draftFor();
    expect(a.doc.token).toBeNull();
    expect(b.doc.token).toBeNull();
    const dup = await openDoc();
    const other = await draftFor();
    await expect(env.DB.prepare(`UPDATE documents SET token = ? WHERE id = ?`).bind(dup.doc.token, other.doc.id).run()).rejects.toThrow();
  });
});

describe("pdf and payment", () => {
  it("setPdf stores the key and hash, or the error", async () => {
    const s = await openDoc();
    await setPdf(env.DB, s.doc.id, { error: "renderer down" });
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfError: "renderer down", pdfKey: null, pdfSha256: null });
    await setPdf(env.DB, s.doc.id, { key: "documents/x.pdf", sha256: "b".repeat(64) });
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfKey: "documents/x.pdf", pdfSha256: "b".repeat(64), pdfError: null });
  });

  it("setPaid records the first payment time only", async () => {
    const s = await openDoc();
    await setPaid(env.DB, s.doc.id, "2026-12-03T10:00:00.000Z");
    await setPaid(env.DB, s.doc.id, "2026-12-04T10:00:00.000Z");
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBe("2026-12-03T10:00:00.000Z");
  });
});
