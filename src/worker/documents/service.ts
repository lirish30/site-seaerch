import type { Env } from "../env";
import { mainMailboxProblem } from "../booking/mail";
import { checkConflict } from "../conflict";
import { latestAudit } from "../db/audits";
import { lastBookingFor } from "../db/bookings";
import { logActivity } from "../db/activity";
import { getBusiness } from "../db/businesses";
import { getDeal, type Deal } from "../db/deals";
import { getOnboardingForDeal } from "../db/onboardings";
import {
  DocumentStateError, createDraft, listForDeal, markSent, nextDraftVersion, updateDraft, voidDocument, type Document,
} from "../db/documents";
import { getPackage, type Package } from "../db/packages";
import { getSettings } from "../db/settings";
import { sendEmail } from "../mail/send";
import type { Settings } from "../types";
import { parseDocumentsConfig, legalGate } from "./config";
import { ESIGN_VERSION } from "./consent";
import { canonicalJson, sha256Hex } from "./hash";
import { clientBase, clientLink, renderProposalMail } from "./mail";
import { ProposalError, buildProposal, freezeProposal, type ProposalEdits } from "./proposal";
import { newClientToken } from "./token";

/** The consent text stored with the owner's countersignature. A test copy says so, so it can never be mistaken for the real thing. */
export const COUNTERSIGN_TEXT = "Approved for sending";
export const COUNTERSIGN_TEST_TEXT = "Test copy to the owner";
const OPEN: Document["status"][] = ["sent", "viewed", "signed"];

/** A test onboarding owns the deal's one onboarding slot for good, so a real proposal paid on that deal would leave the paying client with none. */
export const TEST_ONBOARDING_PROBLEM = "This deal has a test onboarding, so a real proposal cannot be sent on it. Use a new test lead for rehearsals.";
const hasTestOnboarding = async (db: D1Database, dealId: string) => !!(await getOnboardingForDeal(db, dealId))?.test;

/** Marks the stored proposal approvals for these documents withdrawn: the owner approved what a draft said then, and it has changed or gone since. */
export async function withdrawSendApprovals(db: D1Database, documentIds: string[], note: string): Promise<void> {
  if (documentIds.length === 0) return;
  await db.batch(documentIds.map((id) =>
    db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decision_note = ? WHERE kind = 'proposal.send' AND status = 'pending' AND json_extract(payload, '$.documentId') = ?`)
      .bind(new Date().toISOString(), note, id)));
}

/**
 * Builds the proposal for one option of a deal and stores it as the deal's draft: an existing draft is edited in place (and keeps its version number), a
 * draft of the other kind (a test copy and a real one are different documents) is replaced by a new one that takes the same number, and a deal with a sent or
 * signed proposal refuses until that one is voided. Everything priced comes from the deal's frozen snapshot and the catalog versions it names.
 * The contact defaults to the person who booked the discovery call; an explicit contact wins.
 */
export async function draftProposal(
  env: Env, dealId: string,
  o: { optionId: "a" | "b" | "c"; edits: ProposalEdits; contact?: { name: string; email: string }; test?: boolean }, now = new Date(),
): Promise<Document> {
  const db = env.DB;
  const deal = await getDeal(db, dealId);
  if (!deal) throw new ProposalError("This deal was not found.");
  const business = await getBusiness(db, deal.businessId);
  if (!business) throw new ProposalError("This deal's lead was not found.");
  const docs = await listForDeal(db, dealId);
  // A signed test copy (the owner signed his own rehearsal) does not block a real proposal.
  const open = docs.find((d) => OPEN.includes(d.status) && !(d.test && d.status === "signed"));
  if (open) throw new DocumentStateError(open.status === "signed" ? "this deal's proposal is already signed" : `this deal has a ${open.status} proposal (version ${open.version}); void it first to make a new one`);
  const existing = docs.find((d) => d.status === "draft");
  if (!o.test && (await hasTestOnboarding(db, dealId))) throw new DocumentStateError(TEST_ONBOARDING_PROBLEM);

  const [discovery, settings, audit, hourly] = await Promise.all([lastBookingFor(db, deal.businessId, "discovery"), getSettings(db), latestAudit(db, deal.businessId), getPackage(db, "hourly")]);
  if (!hourly) throw new ProposalError("The hourly rate is missing from the package catalog.");
  const rows = await Promise.all(deal.priceSnapshot.map((s) => getPackage(db, s.key, s.version)));
  const packages = rows.filter((p): p is Package => p !== null);
  const contact = o.contact ?? { name: discovery?.contactName ?? "", email: discovery?.contactEmail ?? "" };
  // The platform Logan recorded after the call is what the options were checked against; a deal with no notes falls back to what the audit found.
  const platform = deal.notes?.platform ?? (audit?.platform === "wordpress" ? "wordpress" : "other");

  const reuse = existing && existing.test === !!o.test ? existing : null;
  const version = reuse ? reuse.version : await nextDraftVersion(db, dealId);
  const content = buildProposal({
    deal, optionId: o.optionId, client: { name: business.name, contactName: contact.name, contactEmail: contact.email },
    settings: { your_name: settings.your_name, business_name: settings.business_name, contact_email: settings.contact_email },
    packages, catalogHourly: { hourlyCents: hourly.priceCents, hourlyCareCents: hourly.altPriceCents }, edits: o.edits,
    config: parseDocumentsConfig(settings.documents_config), platform, now, version,
  });
  // Withdraw the waiting approval BEFORE the draft changes: approved in the gap, it would send the edited content under a card that describes the old one.
  if (existing) await withdrawSendApprovals(db, [existing.id], "the draft was edited after it was sent for approval");
  const doc = reuse
    ? await updateDraft(db, reuse.id, content)
    : await createDraft(db, { dealId, businessId: deal.businessId, optionId: o.optionId, content, test: o.test });
  return doc;
}

/** Rebuilds a draft from the deal as it stands now, with new edits. The option, the contact and whether it is a test copy stay as they were. */
export async function editDraft(env: Env, doc: Document, edits: ProposalEdits, now = new Date()): Promise<Document> {
  if (doc.status !== "draft") throw new DocumentStateError("only a draft can be edited");
  return draftProposal(env, doc.dealId, { optionId: doc.optionId, edits, contact: { name: doc.content.header.contactName, email: doc.content.header.contactEmail }, test: doc.test }, now);
}

const stageAllows = (d: Deal) => d.stage === "recommended" || d.stage === "proposal_sent" || (d.stage === "discovery_done" && d.skipCall);

/**
 * Why a real send is refused, in the order Logan would fix them. Always: the lawyer's review is recorded (a test copy is no exception: it never goes
 * through here), the main mailbox can send, the client link base is set, the contact and lead are not blocked, the deal is still one a proposal can go out
 * on, the frozen prices still match their catalog versions. A document that is not a draft is refused, except one this same approval already sent (a
 * retry after the mail failed).
 */
export async function sendProblems(env: Env, doc: Document, o: { approvalId?: string } = {}): Promise<string[]> {
  const db = env.DB;
  const problems: string[] = [];
  if (!doc.test && (await hasTestOnboarding(db, doc.dealId))) problems.push(TEST_ONBOARDING_PROBLEM);
  const settings = await getSettings(db);
  const gate = legalGate(parseDocumentsConfig(settings.documents_config));
  if (gate) problems.push(gate);
  if (doc.test) problems.push("test documents go out with Send a test only");
  const retry = !!o.approvalId && doc.approvalId === o.approvalId && (doc.status === "sent" || doc.status === "viewed");
  if (doc.status !== "draft" && !retry) problems.push(`this proposal is ${doc.status}, not a draft`);
  // The owner's approval countersigns the proposal in these names, so neither may be blank.
  if (!settings.your_name.trim()) problems.push("Add your name in Settings before sending: it is your signature on the proposal.");
  if (!settings.contact_email.trim()) problems.push("Add your contact email in Settings before sending: it is your signature on the proposal.");
  const mailbox = await mainMailboxProblem(env);
  if (mailbox) problems.push(`The main mailbox cannot send: ${mailbox}`);
  if (!clientBase(env)) problems.push(CLIENT_BASE_PROBLEM);
  const conflict = await checkConflict(db, { email: doc.content.header.contactEmail, businessId: doc.businessId });
  if (conflict.blocked) problems.push(`Blocked: ${conflict.reason}`);

  const deal = await getDeal(db, doc.dealId);
  if (!deal) problems.push("this proposal's deal was not found");
  else {
    if (!stageAllows(deal)) problems.push(`The deal is ${deal.stage.replace(/_/g, " ")}, so a proposal cannot go out on it.`);
    const option = deal.options?.find((x) => x.id === doc.optionId);
    for (const item of option?.items ?? []) {
      const snap = deal.priceSnapshot.find((s) => s.key === item.key);
      if (!snap) { problems.push(`${item.key} has no frozen price on this deal.`); continue; }
      const row = await getPackage(db, snap.key, snap.version);
      if (!row) problems.push(`${snap.name} (version ${snap.version}) is missing from the package catalog.`);
      else if (row.priceCents !== snap.priceCents || row.setupCents !== snap.setupCents) problems.push(`${snap.name}: the frozen price differs from its catalog version ${snap.version}. Do not send until the data is checked.`);
    }
  }
  return problems;
}

export const CLIENT_BASE_PROBLEM = "Set CLIENT_LINK_BASE (an https address for client links, not the cold-email host) before sending.";

/** Stamps a draft as sent: a fresh link token, the content frozen with its send and expiry days, its hash, and the owner's countersignature, in one step. */
export async function sealProposal(env: Env, doc: Document, o: { now: Date; approvalId: string | null; test: boolean; settings: Settings }): Promise<Document> {
  if (!doc.test && !o.test && (await hasTestOnboarding(env.DB, doc.dealId))) throw new DocumentStateError(TEST_ONBOARDING_PROBLEM);
  const config = parseDocumentsConfig(o.settings.documents_config);
  const frozen = freezeProposal(doc.content, o.now, config.expiryDays);
  const contentSha256 = await sha256Hex(canonicalJson(frozen));
  const sentAt = o.now.toISOString();
  return markSent(env.DB, doc.id, {
    token: newClientToken(), content: frozen, contentSha256, sentAt, expiresAt: frozen.header.expiresOn!, approvalId: o.approvalId, test: o.test,
    provider: {
      signerName: o.settings.your_name.trim(), signerEmail: o.settings.contact_email.trim(), signedAt: sentAt, ip: null, userAgent: null,
      consentText: o.test ? COUNTERSIGN_TEST_TEXT : COUNTERSIGN_TEXT, consentVersion: ESIGN_VERSION, contentSha256,
    },
  });
}

/**
 * Mails the proposal link to a client from the main mailbox. The approval id is the once-only key (a retried approval cannot send twice); the checks a
 * real send makes are `sendProblems`' to make first, so this goes with `skipLimits`.
 */
export async function mailProposalLink(env: Env, doc: Document, settings: Settings, approvalId: string): Promise<void> {
  const link = clientLink(clientBase(env) ?? undefined, doc.token!);
  if (!link) throw new Error(CLIENT_BASE_PROBLEM);
  const m = renderProposalMail(doc.content, link, settings);
  await sendEmail(env, { mailbox: "main", to: doc.content.header.contactEmail, subject: m.subject, body: m.body, includeFooter: false, businessId: doc.businessId }, { approvalId, skipLimits: true });
}

/**
 * Sends a draft to the owner's own address as a test: the real link, a real (test) document, no approval and no deal move. The document is marked `test`
 * and is no longer a draft, so it is voided before a real one is made. It is not run through the legal gate (the point is to read it before the review).
 */
export async function sendTest(env: Env, doc: Document, now = new Date()): Promise<Document> {
  if (doc.status !== "draft") throw new DocumentStateError("only a draft can be sent as a test");
  const settings = await getSettings(env.DB);
  const to = settings.contact_email.trim();
  if (!to) throw new DocumentStateError("Add your contact email in Settings first: the test goes to it.");
  const mailbox = await mainMailboxProblem(env);
  if (mailbox) throw new DocumentStateError(`The main mailbox cannot send: ${mailbox}`);
  const base = clientBase(env);
  if (!base) throw new DocumentStateError(CLIENT_BASE_PROBLEM);
  const sealed = await sealProposal(env, doc, { now, approvalId: null, test: true, settings });
  const m = renderProposalMail(sealed.content, clientLink(base, sealed.token!)!, settings);
  // No lead and no approval: it is a message to the owner, not outreach.
  await sendEmail(env, { mailbox: "main", to, subject: `[Test] ${m.subject}`, body: m.body, includeFooter: false }, { approvalId: null, skipLimits: true });
  return sealed;
}

/**
 * Voids every sent or viewed proposal of a deal (a deal marked lost has no live link to sign or pay) and logs each once. A document that cannot be voided
 * is logged and left: signing and the page refuse a lost deal on their own. A signed one is a record and stays. Returns how many were voided.
 */
export async function voidOpenProposals(db: D1Database, dealId: string, reason: string): Promise<number> {
  let n = 0;
  for (const d of (await listForDeal(db, dealId)).filter((x) => x.status === "sent" || x.status === "viewed")) {
    try {
      await voidProposal(db, d, reason);
      await logActivity(db, d.businessId, "proposal_void", `${d.content.header.reference} v${d.version}: ${reason}`);
      n++;
    } catch (e) { console.error("proposal: could not void a proposal of a lost deal", e instanceof Error ? e.message : "unknown error"); }
  }
  return n;
}

/** Voids a document with the reason and withdraws any approval still waiting to send it. A void one is returned as it is. */
export async function voidProposal(db: D1Database, doc: Document, reason: string): Promise<Document> {
  // Withdrawn first, so an approval made in the gap finds a draft that is still a draft only if the void then fails.
  await withdrawSendApprovals(db, [doc.id], "the proposal was voided");
  return voidDocument(db, doc.id, reason);
}
