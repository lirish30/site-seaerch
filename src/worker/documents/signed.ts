import { checkConflict } from "../conflict";
import { logActivity } from "../db/activity";
import { getDocument, setPdf, signaturesFor, type Document } from "../db/documents";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { mainMailboxProblem } from "../booking/mail";
import { sendEmail } from "../mail/send";
import { htmlToPdf } from "../render/render";
import { attachmentHeader, safeFileName } from "../routes/deck";
import { showDraftBanner } from "./config";
import { sha256Hex } from "./hash";
import { clientBase, clientLink, renderSignedCopyMail, renderSignedNotice, type ProposalMail } from "./mail";
import { renderProposalHtml } from "./render";

export type SignedPdf = { ok: true; key: string; sha256: string } | { ok: false; status: 404 | 409 | 501 | 502; error: string };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const REASON_MAX = 200;

/** Where a signed document's PDF lives. Signed documents are never deleted by the app (ESIGN retention), so neither is this. */
export const signedPdfKey = (docId: string): string => `documents/${docId}/signed.pdf`;

let rendererForTests: typeof htmlToPdf | null = null;
/** Tests only: real PDF rendering needs the Browser Rendering binding, so a test hands in a fake. Null restores the real one. */
export function setPdfRendererForTests(fn: typeof htmlToPdf | null): void {
  rendererForTests = fn;
}

/**
 * Makes the signed PDF if it does not exist yet, and returns where it is. It is what the signing step calls and what the download routes call when
 * the first try did not make one, so a failure is never final: the next request tries again. It renders the frozen content with the stored signatures,
 * the audit page and the stored `contentSha256`, nothing from settings, so the same document always reads the same. The file is stored only if none is
 * there yet (put-if-absent): a file left by an attempt that died before recording it is the signed copy, and is adopted rather than replaced, so the
 * hash on the document is always the hash of the stored file. A failure records `pdfError` and is a 502; no browser binding is a 501 that records nothing.
 */
export async function ensureSignedPdf(env: Env, docId: string, deps: { pdf?: typeof htmlToPdf } = {}): Promise<SignedPdf> {
  const doc = await getDocument(env.DB, docId);
  if (!doc) return { ok: false, status: 404, error: "not found" };
  if (doc.status !== "signed") return { ok: false, status: 409, error: "only a signed document has a signed PDF" };
  if (doc.pdfKey && doc.pdfSha256) return { ok: true, key: doc.pdfKey, sha256: doc.pdfSha256 };
  if (!env.BROWSER) return { ok: false, status: 501, error: "PDF export needs the Browser Rendering binding" };

  const key = signedPdfKey(doc.id);
  try {
    const signatures = await signaturesFor(env.DB, doc.id);
    const html = renderProposalHtml(doc.content, { mode: "pdf", status: doc.status, contentSha256: doc.contentSha256, signatures, auditPage: true, draftBanner: showDraftBanner(doc, null) });
    let bytes = await (deps.pdf ?? rendererForTests ?? htmlToPdf)(env.BROWSER, html, { format: "letter" });
    if (bytes.byteLength === 0) throw new Error("the renderer returned an empty file");
    const stored = await env.RAW.put(key, bytes, { httpMetadata: { contentType: "application/pdf" }, onlyIf: { etagDoesNotMatch: "*" } });
    if (!stored) {
      const existing = await env.RAW.get(key);
      if (!existing) throw new Error("the signed PDF could not be stored");
      bytes = new Uint8Array(await existing.arrayBuffer());
    }
    const sha256 = await sha256Hex(bytes);
    await setPdf(env.DB, doc.id, { key, sha256 });
    return { ok: true, key, sha256 };
  } catch (e) {
    const reason = oneLine(e instanceof Error ? e.message : "unknown error").slice(0, REASON_MAX);
    console.error("proposal: could not make the signed PDF", reason);
    await setPdf(env.DB, doc.id, { error: reason }).catch((err) => console.error("proposal: could not record the PDF failure", err instanceof Error ? err.message : "unknown error"));
    return { ok: false, status: 502, error: "could not make the PDF, please try again" };
  }
}

/** "<Business> - Proposal - <YYYY-MM-DD>.pdf", the business name made safe by `safeFileName`. */
export function signedFileName(clientName: string, now: Date, o: { ascii?: boolean } = {}): string {
  return `${safeFileName(clientName, o)} - Proposal - ${now.toISOString().slice(0, 10)}.pdf`;
}

/** The signed PDF of a signed document as a download, made first if it is not there yet. Both routes answer with this. The file is named for the day it was signed. */
export async function signedPdfResponse(env: Env, doc: Document): Promise<Response> {
  const r = await ensureSignedPdf(env, doc.id);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  const file = await env.RAW.get(r.key);
  if (!file) {
    console.error("proposal: the signed PDF is recorded but not in storage", doc.id);
    return Response.json({ error: "the signed PDF could not be read" }, { status: 502 });
  }
  const name = doc.content.header.clientName, day = new Date(doc.signedAt ?? doc.updatedAt);
  return new Response(file.body, {
    headers: {
      "content-type": "application/pdf", "content-length": String(file.size), "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-disposition": attachmentHeader(signedFileName(name, day, { ascii: true }), signedFileName(name, day)),
    },
  });
}

/** Sends one fixed-template mail from the `main` mailbox. It has no approval and so goes as `skipLimits`: the callers make the checks that matter first. */
const sendFromMain = (env: Env, businessId: string, to: string, m: ProposalMail) =>
  sendEmail(env, { mailbox: "main", to, subject: m.subject, body: m.body, includeFooter: false, businessId }, { approvalId: null, skipLimits: true });

/** Runs one send; whatever goes wrong is logged on the lead's timeline and in the Worker log, never thrown. */
async function attempt(env: Env, businessId: string, what: string, send: () => Promise<void>): Promise<void> {
  try { await send(); }
  catch (e) {
    const reason = oneLine(e instanceof Error ? e.message : "unknown error").slice(0, REASON_MAX);
    console.error(`proposal: ${what} not sent`, reason);
    await logActivity(env.DB, businessId, "note", `${what} not sent: ${reason}`).catch((err) => console.error(`proposal: could not log the unsent ${what}`, err instanceof Error ? err.message : "unknown error"));
  }
}

/**
 * The signed copy: a fixed-template mail from `main` to the signer with the client's link (the page serves the PDF), and a short notice to the owner's
 * contact address. It is the one decided unapproved send to a prospect, so the conflict gate runs on the signer's address first (at signing the lead is
 * not yet a client; payment comes later). Each of the two is its own attempt, so one that cannot go (no mailbox, a do-not-contact address, an SMTP error)
 * never stops the other. A test copy mails only the owner (the signer address on it is the real prospect's). It never throws: a failure is a `note` on the lead and a Worker log line, and the signature stands.
 */
export async function sendSignedCopy(env: Env, doc: Document): Promise<void> {
  // A test copy goes to the address on the proposal, which is the real prospect's: never mail it. Only the owner's notice (marked as a test) goes.
  if (!doc.test) await attempt(env, doc.businessId, "signed copy", async () => {
    const signer = (await signaturesFor(env.DB, doc.id)).find((s) => s.role === "client");
    if (!signer) throw new Error("the document has no client signature");
    const problem = await mainMailboxProblem(env);
    if (problem) throw new Error(problem);
    const gate = await checkConflict(env.DB, { email: signer.signerEmail, businessId: doc.businessId });
    if (gate.blocked) throw new Error(gate.reason);
    const link = doc.token ? clientLink(clientBase(env) ?? undefined, doc.token) : null;
    await sendFromMain(env, doc.businessId, signer.signerEmail, renderSignedCopyMail(doc.content, link, await getSettings(env.DB)));
  });
  await attempt(env, doc.businessId, "signature notice", async () => {
    const to = (await getSettings(env.DB)).contact_email.trim();
    if (!to) return;
    const problem = await mainMailboxProblem(env);
    if (problem) throw new Error(problem);
    await sendFromMain(env, doc.businessId, to, renderSignedNotice(doc.content, { test: doc.test }));
  });
}
