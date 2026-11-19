import type { ProposalContent } from "../documents/proposal";

export type DocumentStatus = "draft" | "sent" | "viewed" | "signed" | "void" | "expired";
type OptionId = "a" | "b" | "c";

export interface Document {
  id: string; dealId: string; businessId: string; version: number; status: DocumentStatus; test: boolean; optionId: OptionId;
  content: ProposalContent; contentSha256: string | null; token: string | null;
  sentAt: string | null; expiresAt: string | null; firstViewedAt: string | null; signedAt: string | null; paidAt: string | null; voidReason: string | null;
  pdfKey: string | null; pdfSha256: string | null; pdfError: string | null; approvalId: string | null; createdAt: string; updatedAt: string;
}

export interface SignatureRecord {
  id: string; documentId: string; role: "provider" | "client"; signerName: string; signerEmail: string; signedAt: string;
  ip: string | null; userAgent: string | null; consentText: string; consentVersion: number; contentSha256: string;
}
type SignatureInput = Omit<SignatureRecord, "id" | "documentId" | "role">;

/** The document is not in a state that allows this (a 409). */
export class DocumentStateError extends Error {}

/** A visitor opening the link again within this long is not a new view. */
const VIEW_GAP_MS = 10 * 60_000;

interface Row {
  id: string; deal_id: string; business_id: string; version: number; status: DocumentStatus; test: number; option_id: OptionId;
  content: string; content_sha256: string | null; token: string | null;
  sent_at: string | null; expires_at: string | null; first_viewed_at: string | null; signed_at: string | null; paid_at: string | null; void_reason: string | null;
  pdf_key: string | null; pdf_sha256: string | null; pdf_error: string | null; approval_id: string | null; created_at: string; updated_at: string;
}
interface SigRow {
  id: string; document_id: string; role: "provider" | "client"; signer_name: string; signer_email: string; signed_at: string;
  ip: string | null; user_agent: string | null; consent_text: string; consent_version: number; content_sha256: string;
}

/** The content column holds what the proposal builder produced, so it is read back as is. */
const toDocument = (r: Row): Document => ({
  id: r.id, dealId: r.deal_id, businessId: r.business_id, version: r.version, status: r.status, test: !!r.test, optionId: r.option_id,
  content: JSON.parse(r.content) as ProposalContent, contentSha256: r.content_sha256, token: r.token,
  sentAt: r.sent_at, expiresAt: r.expires_at, firstViewedAt: r.first_viewed_at, signedAt: r.signed_at, paidAt: r.paid_at, voidReason: r.void_reason,
  pdfKey: r.pdf_key, pdfSha256: r.pdf_sha256, pdfError: r.pdf_error, approvalId: r.approval_id, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toSignature = (r: SigRow): SignatureRecord => ({
  id: r.id, documentId: r.document_id, role: r.role, signerName: r.signer_name, signerEmail: r.signer_email, signedAt: r.signed_at,
  ip: r.ip, userAgent: r.user_agent, consentText: r.consent_text, consentVersion: r.consent_version, contentSha256: r.content_sha256,
});

export async function getDocument(db: D1Database, id: string): Promise<Document | null> {
  const r = await db.prepare(`SELECT * FROM documents WHERE id = ?`).bind(id).first<Row>();
  return r ? toDocument(r) : null;
}

export async function getByToken(db: D1Database, token: string): Promise<Document | null> {
  const r = await db.prepare(`SELECT * FROM documents WHERE token = ?`).bind(token).first<Row>();
  return r ? toDocument(r) : null;
}

/** Every version for a deal, newest first. */
export async function listForDeal(db: D1Database, dealId: string): Promise<Document[]> {
  return (await db.prepare(`SELECT * FROM documents WHERE deal_id = ? ORDER BY version DESC`).bind(dealId).all<Row>()).results.map(toDocument);
}

export async function signaturesFor(db: D1Database, id: string): Promise<SignatureRecord[]> {
  return (await db.prepare(`SELECT * FROM document_signatures WHERE document_id = ? ORDER BY signed_at, role`).bind(id).all<SigRow>()).results.map(toSignature);
}

export async function countViews(db: D1Database, id: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM document_views WHERE document_id = ?`).bind(id).first<{ n: number }>())!.n;
}

/** Whether the lead has a document that is anything but a draft (sent, signed, void or expired): those are records the app never deletes. */
export async function hasNonDraftDocument(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM documents WHERE business_id = ? AND status != 'draft' LIMIT 1`).bind(businessId).first());
}

/** The statements that remove a lead's drafts (with their views), to run before its deals go. A document that is not a draft is left, so the delete that follows fails rather than losing it. */
export function deleteDraftDocumentStmts(db: D1Database, businessId: string): D1PreparedStatement[] {
  const drafts = `SELECT id FROM documents WHERE business_id = ? AND status = 'draft'`;
  return [
    db.prepare(`DELETE FROM document_views WHERE document_id IN (${drafts})`).bind(businessId),
    db.prepare(`DELETE FROM document_signatures WHERE document_id IN (${drafts})`).bind(businessId),
    db.prepare(`DELETE FROM documents WHERE business_id = ? AND status = 'draft'`).bind(businessId),
  ];
}

/**
 * The version number the deal's next draft takes: the existing draft's own (a draft is rebuilt in place, so its number is reused and none is skipped),
 * or one more than the highest the deal has had.
 */
export async function nextDraftVersion(db: D1Database, dealId: string): Promise<number> {
  const r = await db.prepare(
    `SELECT COALESCE((SELECT version FROM documents WHERE deal_id = ? AND status = 'draft'), (SELECT COALESCE(MAX(version), 0) FROM documents WHERE deal_id = ?) + 1) AS v`,
  ).bind(dealId, dealId).first<{ v: number }>();
  return r?.v ?? 1;
}

/**
 * A new draft for the deal. It replaces the deal's existing draft (a draft is only ever edited or rebuilt) and takes that draft's version number, or
 * one more than the highest the deal has had when there is none (`nextDraftVersion`). A deal with a sent, viewed or signed document refuses: void it first.
 * A signed TEST copy does not block (it is the owner's own rehearsal and is voided or left in the history).
 */
export async function createDraft(db: D1Database, o: { dealId: string; businessId: string; optionId: OptionId; content: ProposalContent; test?: boolean }): Promise<Document> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const version = await nextDraftVersion(db, o.dealId);
  const res = await db.batch([
    db.prepare(`DELETE FROM documents WHERE deal_id = ? AND status = 'draft'`).bind(o.dealId),
    // Guarded in the statement, so a document sent between the read and the write still blocks it.
    db.prepare(
      `INSERT INTO documents (id, deal_id, business_id, version, status, test, option_id, content, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE deal_id = ? AND (status IN ('sent', 'viewed') OR (status = 'signed' AND test = 0)))`,
    ).bind(id, o.dealId, o.businessId, version, o.test ? 1 : 0, o.optionId, JSON.stringify(o.content), now, now, o.dealId),
  ]);
  if ((res[1].meta.changes ?? 0) !== 1) throw new DocumentStateError("this deal already has a sent or signed proposal; void it first");
  return (await getDocument(db, id))!;
}

/** Replaces a draft's content (and so its option). Anything but a draft is frozen. */
export async function updateDraft(db: D1Database, id: string, content: ProposalContent): Promise<Document> {
  const res = await db.prepare(`UPDATE documents SET content = ?, option_id = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
    .bind(JSON.stringify(content), content.optionId, new Date().toISOString(), id).run();
  if ((res.meta.changes ?? 0) !== 1) throw new DocumentStateError("only a draft can be edited");
  return (await getDocument(db, id))!;
}

/**
 * Sends a draft: it becomes `sent` with the frozen content, its hash and the client's token, and the provider's signature is stored, in one batch.
 * A retried approval (the same `approvalId` on a document already sent for it) returns the document as it is. Any other document that is not a draft refuses.
 */
export async function markSent(db: D1Database, id: string, o: {
  token: string; content: ProposalContent; contentSha256: string; sentAt: string; expiresAt: string; approvalId: string | null; provider: SignatureInput;
  /** True for the owner's own test copy: the document is marked `test` (it never moves a deal or takes a payment). */
  test?: boolean;
}): Promise<Document> {
  const doc = await getDocument(db, id);
  if (!doc) throw new DocumentStateError("document not found");
  const retried = (d: Document) => d.approvalId !== null && d.approvalId === o.approvalId;
  if (retried(doc)) return doc;
  if (doc.status !== "draft") throw new DocumentStateError(`a ${doc.status} document cannot be sent`);
  const p = o.provider;
  const res = await db.batch([
    db.prepare(
      `UPDATE documents SET status = 'sent', content = ?, option_id = ?, content_sha256 = ?, token = ?, sent_at = ?, expires_at = ?, approval_id = ?, test = MAX(test, ?), updated_at = ?
       WHERE id = ? AND status = 'draft'`,
    ).bind(JSON.stringify(o.content), o.content.optionId, o.contentSha256, o.token, o.sentAt, o.expiresAt, o.approvalId, o.test ? 1 : 0, o.sentAt, id),
    // Only when the update above took: the document now carries this call's token.
    db.prepare(
      `INSERT INTO document_signatures (id, document_id, role, signer_name, signer_email, signed_at, ip, user_agent, consent_text, consent_version, content_sha256)
       SELECT ?, ?, 'provider', ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND status = 'sent' AND token = ?)`,
    ).bind(crypto.randomUUID(), id, p.signerName, p.signerEmail, p.signedAt, p.ip, p.userAgent, p.consentText, p.consentVersion, p.contentSha256, id, o.token),
  ]);
  if ((res[0].meta.changes ?? 0) !== 1) {
    // Another send won the race: if it was this same approval, that is the answer.
    const now = await getDocument(db, id);
    if (now && retried(now)) return now;
    throw new DocumentStateError("the document changed; reload and try again");
  }
  return (await getDocument(db, id))!;
}

/**
 * Records that the client opened the link: one row, and not again within ten minutes of the last one. The first view moves `sent` to `viewed` and
 * answers true; every other call answers false. A draft has no link, so it records nothing.
 */
export async function recordView(db: D1Database, id: string, o: { now: string; userAgent: string | null }): Promise<boolean> {
  const since = new Date(Date.parse(o.now) - VIEW_GAP_MS).toISOString();
  const res = await db.batch([
    db.prepare(
      `INSERT INTO document_views (id, document_id, viewed_at, user_agent)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND status != 'draft')
         AND NOT EXISTS (SELECT 1 FROM document_views WHERE document_id = ? AND viewed_at > ?)`,
    ).bind(crypto.randomUUID(), id, o.now, o.userAgent, id, id, since),
    db.prepare(`UPDATE documents SET status = 'viewed', first_viewed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`).bind(o.now, o.now, id),
  ]);
  return (res[1].meta.changes ?? 0) === 1; // true only for the visit that moved sent to viewed
}

/**
 * Stores the client's signature and marks the document signed. The insert is conditional (the document is open, not expired and still the content
 * whose hash the client saw) and runs with the status update in one batch, so two signs at once leave one signature: the second finds the document
 * already signed. A void, expired, draft or changed document is `not_open`.
 */
export async function signDocument(db: D1Database, id: string, sig: SignatureInput, now: string): Promise<"signed" | "already_signed" | "not_open"> {
  const res = await db.batch([
    db.prepare(
      `INSERT INTO document_signatures (id, document_id, role, signer_name, signer_email, signed_at, ip, user_agent, consent_text, consent_version, content_sha256)
       SELECT ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND status IN ('sent', 'viewed') AND expires_at > ? AND content_sha256 = ?)`,
    ).bind(crypto.randomUUID(), id, sig.signerName, sig.signerEmail, sig.signedAt, sig.ip, sig.userAgent, sig.consentText, sig.consentVersion, sig.contentSha256, id, now, sig.contentSha256),
    db.prepare(
      `UPDATE documents SET status = 'signed', signed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('sent', 'viewed')
         AND EXISTS (SELECT 1 FROM document_signatures WHERE document_id = ? AND role = 'client')`,
    ).bind(sig.signedAt, now, id, id),
  ]);
  if ((res[0].meta.changes ?? 0) === 1) return "signed";
  const doc = await getDocument(db, id);
  return doc?.status === "signed" ? "already_signed" : "not_open";
}

/**
 * Voids a draft, sent or viewed document with the reason. A signed (or expired) real one refuses; a void one is returned as it is. A TEST copy can be
 * voided in any state (the owner may sign his own rehearsal): its signature rows are never touched.
 */
export async function voidDocument(db: D1Database, id: string, reason: string): Promise<Document> {
  const res = await db.prepare(`UPDATE documents SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ? AND (status IN ('draft', 'sent', 'viewed') OR (test = 1 AND status != 'void'))`)
    .bind(reason, new Date().toISOString(), id).run();
  const doc = await getDocument(db, id);
  if (!doc) throw new DocumentStateError("document not found");
  if ((res.meta.changes ?? 0) !== 1 && doc.status !== "void") throw new DocumentStateError(`a ${doc.status} document cannot be voided`);
  return doc;
}

/**
 * Marks every sent or viewed document whose time has run out (`expires_at` before `now`: at the exact instant it is still open) as expired and returns
 * exactly those documents, so a caller can log each once: a document already expired is not matched again.
 */
export async function expireDue(db: D1Database, now: string): Promise<Document[]> {
  const res = await db.prepare(`UPDATE documents SET status = 'expired', updated_at = ? WHERE status IN ('sent', 'viewed') AND expires_at < ? RETURNING *`).bind(now, now).all<Row>();
  return res.results.map(toDocument);
}

/** A sent or viewed document of a deal still at `proposal_sent`, for the Today follow-up. */
export interface OpenProposal { businessId: string; sentAt: string; viewed: boolean; }

/**
 * The real (not test) proposals out for signature that were sent at or before `sentBefore`: the deal is at `proposal_sent` and the document is sent or
 * viewed and not past its expiry (an expired-but-unswept one is not here), so a signed, void or expired one, or a deal that moved on (won, lost), is not here. Oldest first.
 */
export async function openProposalsSentBefore(db: D1Database, sentBefore: string, now: string = new Date().toISOString()): Promise<OpenProposal[]> {
  const rows = (await db.prepare(
    `SELECT doc.business_id, doc.sent_at, doc.status FROM documents doc JOIN deals d ON d.id = doc.deal_id
     WHERE d.stage = 'proposal_sent' AND doc.status IN ('sent', 'viewed') AND doc.test = 0 AND doc.sent_at IS NOT NULL AND doc.sent_at <= ? AND doc.expires_at >= ?
     ORDER BY doc.sent_at, doc.id`,
  ).bind(sentBefore, now).all<{ business_id: string; sent_at: string; status: string }>()).results;
  return rows.map((r) => ({ businessId: r.business_id, sentAt: r.sent_at, viewed: r.status === "viewed" }));
}

/** Stores where the signed PDF is and its hash, or why it could not be made. */
export async function setPdf(db: D1Database, id: string, o: { key: string; sha256: string } | { error: string }): Promise<void> {
  const now = new Date().toISOString();
  // A failure is only noted while there is no file: a concurrent success must not leave an error beside its key.
  if ("error" in o) await db.prepare(`UPDATE documents SET pdf_error = ?, updated_at = ? WHERE id = ? AND pdf_key IS NULL`).bind(o.error, now, id).run();
  else await db.prepare(`UPDATE documents SET pdf_key = ?, pdf_sha256 = ?, pdf_error = NULL, updated_at = ? WHERE id = ?`).bind(o.key, o.sha256, now, id).run();
}

/** Records when the deposit was paid. The first payment time stands. */
export async function setPaid(db: D1Database, id: string, at: string): Promise<void> {
  await db.prepare(`UPDATE documents SET paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?`).bind(at, at, id).run();
}
