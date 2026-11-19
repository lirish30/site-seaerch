import { z } from "zod";
import { nameProblem } from "../../client/proposalPageView";
import { logActivity } from "../db/activity";
import { getDeal } from "../db/deals";
import { getByToken, getDocument, recordView, signaturesFor, signDocument, type Document } from "../db/documents";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { legalGate, parseDocumentsConfig } from "./config";
import { CONSENT_LABEL, ESIGN_DISCLOSURE, ESIGN_VERSION, authorityLabel } from "./consent";
import { ensureDepositInvoice, paymentFor, type PublicPayment } from "./deposit";
import { renderProposalHtml } from "./render";
import { ensureSignedPdf, sendSignedCopy } from "./signed";
import { isClientToken } from "./token";

/** Stored with a signature: what a hostile client sends is cut to this, never refused. */
const USER_AGENT_MAX = 300;
const IP_MAX = 64;

export type { PublicPayment };

/** What the page shows while a proposal is open to sign, or after it is signed (the paper stays readable). */
export interface OpenProposal {
  state: "open" | "signed";
  /** The proposal as one self-contained page, to be shown in a sandboxed frame. The renderer escapes every dynamic string and never emits a script. */
  html: string;
  /** The fingerprint the client signs against: sent back with the sign request, and refused when the document is no longer this one. */
  contentSha256: string;
  expiresAt: string | null;
  clientName: string;
  /** The ESIGN disclosure and the two checkbox texts exactly as they are stored with the signature. */
  disclosure: string;
  consentLabel: string;
  authorityLabel: string;
  signed: { name: string; at: string } | null;
  payment: PublicPayment;
  /** The sender's address, for "write to us". */
  contactEmail: string;
}

/** A void or expired proposal: no content at all, only whose it was and who to write to. */
export interface ClosedProposal { state: "closed"; clientName: string; contactEmail: string }

export type PublicProposal = OpenProposal | ClosedProposal;

/** The ESIGN consent as shown and stored: the disclosure, then the two checkbox texts. */
export const consentTextFor = (clientName: string): string => [ESIGN_DISCLOSURE, CONSENT_LABEL, authorityLabel(clientName)].join("\n\n");

export const SignFormSchema = z.object({
  name: z.string().transform((s) => s.trim()).superRefine((s, ctx) => {
    const problem = nameProblem(s);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  consent: z.literal(true),
  authority: z.literal(true),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
}).strict();
export type SignForm = z.infer<typeof SignFormSchema>;

const capped = (s: string | null, max: number): string | null => (s === null ? null : s.slice(0, max));

/** The document behind a link, or null: not a token, unknown, still a draft, or a test copy whose deal is gone. */
async function find(env: Env, token: string): Promise<Document | null> {
  if (!isClientToken(token)) return null;
  const doc = await getByToken(env.DB, token);
  if (!doc || doc.status === "draft" || !doc.token) return null;
  if (doc.test && !(await getDeal(env.DB, doc.dealId))) return null;
  return doc;
}

/** Void and expired are closed. So is a sent or viewed one whose time has run out, whether or not the nightly sweep has marked it yet (signing refuses it from the expiry instant). */
function isClosed(doc: Document, now: Date): boolean {
  if (doc.status === "void" || doc.status === "expired") return true;
  if (doc.status === "sent" || doc.status === "viewed") return !(doc.expiresAt !== null && Date.parse(doc.expiresAt) > now.getTime());
  return false;
}

/** The page for a document. Only an open document records the view (`view`): a signed, void or expired one is not a prospect reading it. */
async function pageFor(env: Env, doc: Document, now: Date, view: { userAgent: string | null } | null): Promise<PublicProposal> {
  const [settings, signatures] = await Promise.all([getSettings(env.DB), signaturesFor(env.DB, doc.id)]);
  const clientName = doc.content.header.clientName;
  const contactEmail = settings.contact_email.trim() || doc.content.header.providerEmail;
  if (isClosed(doc, now)) return { state: "closed", clientName, contactEmail };

  if (view && (doc.status === "sent" || doc.status === "viewed")) {
    // Counting a visit must never stop the client reading their proposal.
    try { await recordView(env.DB, doc.id, { now: now.toISOString(), userAgent: capped(view.userAgent, USER_AGENT_MAX) }); }
    catch (e) { console.error("proposal: could not record a view", e instanceof Error ? e.message : "unknown error"); }
  }
  const mine = signatures.find((s) => s.role === "client");
  const html = renderProposalHtml(doc.content, {
    mode: "screen", status: doc.status, contentSha256: doc.contentSha256, signatures, auditPage: false,
    draftBanner: doc.test || legalGate(parseDocumentsConfig(settings.documents_config)) !== null,
  });
  return {
    state: doc.status === "signed" ? "signed" : "open", html, contentSha256: doc.contentSha256 ?? "", expiresAt: doc.expiresAt, clientName,
    disclosure: ESIGN_DISCLOSURE, consentLabel: CONSENT_LABEL, authorityLabel: authorityLabel(clientName),
    signed: mine ? { name: mine.signerName, at: mine.signedAt } : null, payment: await paymentFor(env, doc), contactEmail,
  };
}

/** The client's page for a link, or null for a malformed or unknown token, a draft, or a test copy whose deal is gone. Opening it records the view. */
export async function proposalPage(env: Env, token: string, o: { now: Date; userAgent: string | null }): Promise<PublicProposal | null> {
  const doc = await find(env, token);
  return doc ? pageFor(env, doc, o.now, { userAgent: o.userAgent }) : null;
}

/**
 * What runs once after a new signature, in this order. Each step is guarded on its own, so one that fails never stops the next. Nothing here is the only
 * way to get what it makes: the PDF is also made when it is first asked for (`ensureSignedPdf`), and the signed copy is best-effort, once. A new step is
 * one more line.
 */
const AFTER_SIGN_STEPS: { name: string; run: (env: Env, doc: Document) => Promise<unknown> }[] = [
  { name: "signed pdf", run: async (env, doc) => { const r = await ensureSignedPdf(env, doc.id); if (!r.ok) console.error("proposal: no signed PDF yet", r.status); } },
  { name: "signed copy", run: sendSignedCopy },
  // Last, and never the only way to get an invoice: the page's pay button asks for it again (`ensureDepositInvoice` is idempotent), as does the owner's retry.
  { name: "deposit invoice", run: (env, doc) => ensureDepositInvoice(env, doc.id) },
];

/** Runs after a signature is stored: the signed PDF, the signed copy by mail and the deposit invoice. Never throws: nothing here may undo a signature. */
export async function afterSign(env: Env, doc: Document): Promise<void> {
  for (const step of AFTER_SIGN_STEPS) {
    try { await step.run(env, doc); }
    catch (e) { console.error(`proposal: after-sign step "${step.name}" failed`, e instanceof Error ? e.message : "unknown error"); }
  }
}

/** The signed document behind a link, for the PDF download: null for anything that is not signed, exactly as for a link that is not live. */
export async function signedProposalFor(env: Env, token: string): Promise<Document | null> {
  const doc = await find(env, token);
  return doc?.status === "signed" ? doc : null;
}

export type SignResult = { ok: true; page: PublicProposal } | { ok: false; status: 400 | 404 | 409; error: string };

const CLOSED: SignResult = { ok: false, status: 409, error: "this proposal is no longer open" };

/**
 * Signs a proposal. The token is checked before the form is looked at, so a bad form on a link that is not real is a 404. The hash must be the one the
 * client was shown (a document that changed since is a 409), a second sign by the same document answers with the first signature and writes nothing,
 * and the store itself is conditional (`signDocument`), so two requests at once leave one signature. `form` is what the client sent: it is validated here.
 */
export async function signProposal(
  env: Env, token: string, form: unknown, o: { now: Date; ip: string | null; userAgent: string | null },
): Promise<SignResult> {
  const doc = await find(env, token);
  if (!doc) return { ok: false, status: 404, error: "not found" };
  const parsed = SignFormSchema.safeParse(form);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid form" };
  const f = parsed.data;
  if (isClosed(doc, o.now)) return CLOSED;
  if (f.sha256 !== doc.contentSha256) return { ok: false, status: 409, error: "this proposal changed, reload" };

  if (doc.status !== "signed") {
    const at = o.now.toISOString();
    const outcome = await signDocument(env.DB, doc.id, {
      signerName: f.name, signerEmail: doc.content.header.contactEmail, signedAt: at, ip: capped(o.ip, IP_MAX), userAgent: capped(o.userAgent, USER_AGENT_MAX),
      consentText: consentTextFor(doc.content.header.clientName), consentVersion: ESIGN_VERSION, contentSha256: f.sha256,
    }, at);
    if (outcome === "not_open") return CLOSED;
    if (outcome === "signed") {
      // The signature is the record: a failed log line or a failed follow-up never takes it back.
      try { await logActivity(env.DB, doc.businessId, "proposal_signed", `Signed by ${f.name} (version ${doc.version})`); }
      catch (e) { console.error("proposal: could not log the signature", e instanceof Error ? e.message : "unknown error"); }
      const signed = await getDocument(env.DB, doc.id);
      try { if (signed) await afterSign(env, signed); }
      catch (e) { console.error("proposal: after-sign step failed", e instanceof Error ? e.message : "unknown error"); }
    }
  }
  const now = await getDocument(env.DB, doc.id);
  return now ? { ok: true, page: await pageFor(env, now, o.now, null) } : { ok: false, status: 404, error: "not found" };
}
