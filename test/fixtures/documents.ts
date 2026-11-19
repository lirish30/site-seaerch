import { env } from "cloudflare:test";
import { createDeal, moveDeal, saveNotes, saveOptions, type DealStage } from "../../src/worker/db/deals";
import { insertBookingIfFree } from "../../src/worker/db/bookings";
import { listCurrentPackages } from "../../src/worker/db/packages";
import { saveMailbox } from "../../src/worker/db/mailboxes";
import { saveSettings } from "../../src/worker/db/settings";
import { setMailDeps } from "../../src/worker/mail/deps";
import type { OutboundMessage } from "../../src/worker/mail/types";
import { offerOf } from "../../src/worker/queue/callRecap";
import type { Option } from "../../src/worker/sales/options";
import { sha256Hex, canonicalJson } from "../../src/worker/documents/hash";
import { setPdfRendererForTests } from "../../src/worker/documents/signed";
import { newClientToken } from "../../src/worker/documents/token";
import { markSent, type SignatureRecord } from "../../src/worker/db/documents";
import type { ProposalContent } from "../../src/worker/documents/proposal";
import { seedBusiness } from "./cro";
import { NOTES } from "./deal";
import { insertTestAudit } from "./video";

/** A small valid proposal: the storage layer keeps it as JSON and never reads inside it. */
export const proposal = (o: { version?: number; optionId?: "a" | "b" | "c"; scopeNotes?: string } = {}): ProposalContent => ({
  header: {
    reference: "SL-ABCDEF", version: o.version ?? 1, preparedOn: "2026-12-01T17:00:00.000Z", sentOn: null, expiresOn: null, clientName: "Ace Plumbing", contactName: "Pat Jones",
    contactEmail: "pat@ace.test", providerName: "Pat Provider", providerBusiness: "Siteline", providerEmail: "hello@siteline.test",
  },
  optionId: o.optionId ?? "b", packages: [], scopeNotes: o.scopeNotes ?? "", assumptions: [], outOfScope: [], phases: [],
  schedule: { milestones: [], recurring: [], depositCents: 199850 }, careDeclined: false, clauses: [], clauseLibraryVersion: 1,
});

/** A lead with its open deal: documents hang off the deal. */
export async function seedDeal() {
  const b = await seedBusiness();
  const deal = await createDeal(env.DB, { businessId: b.id, source: "manual" });
  return { businessId: b.id, dealId: deal.id };
}

export const SENT_AT = "2026-12-01T17:00:00.000Z";
export const EXPIRES_AT = "2026-12-15T17:00:00.000Z";
export const providerSig = (hash: string): Omit<SignatureRecord, "id" | "documentId" | "role"> => ({
  signerName: "Pat Provider", signerEmail: "hello@siteline.test", signedAt: SENT_AT, ip: null, userAgent: null, consentText: "I agree.", consentVersion: 1, contentSha256: hash,
});
export const clientSig = (hash: string, o: { signedAt?: string } = {}): Omit<SignatureRecord, "id" | "documentId" | "role"> => ({
  signerName: "Pat Jones", signerEmail: "pat@ace.test", signedAt: o.signedAt ?? "2026-12-02T09:00:00.000Z", ip: "203.0.113.9", userAgent: "TestBrowser/1.0",
  consentText: "I agree to sign electronically.", consentVersion: 1, contentSha256: hash,
});

/** Sends a draft the way the approval will: frozen content, its hash, a fresh token, the provider signature. */
export async function sendDraft(id: string, content: ProposalContent, o: { approvalId?: string | null; expiresAt?: string } = {}) {
  const expiresAt = o.expiresAt ?? EXPIRES_AT;
  const frozen = { ...content, header: { ...content.header, sentOn: SENT_AT, expiresOn: expiresAt } };
  const hash = await sha256Hex(canonicalJson(frozen));
  const doc = await markSent(env.DB, id, {
    token: newClientToken(), content: frozen, contentSha256: hash, sentAt: SENT_AT, expiresAt,
    approvalId: o.approvalId === undefined ? null : o.approvalId, provider: providerSig(hash),
  });
  return { doc, hash };
}

// ---- Task 6: a deal that is ready for a proposal, and a mailbox that can send it ----

export const PROPOSAL_OPTIONS: Option[] = [
  { id: "a", label: "Fix it", tagline: "The quick fixes", items: [{ key: "quick_fix" }], recommended: false },
  { id: "b", label: "Starter", tagline: "A new site", items: [{ key: "starter_site" }, { key: "care" }], recommended: true },
  { id: "c", label: "Growth", tagline: "A bigger site", items: [{ key: "growth_site" }, { key: "care" }], recommended: false },
];

/** A lead with a deal at `recommended`: options and the price snapshot as the recap stores them, notes (WordPress) and, by default, a booked discovery call with a contact. */
let slotN = 0;
/** A free half hour for each seeded call: a booking never overlaps another. */
const nextSlot = () => { const start = new Date(Date.parse("2027-03-01T18:00:00.000Z") + slotN++ * 3_600_000); return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 20 * 60_000).toISOString() }; };

export async function seedProposalDeal(o: { name?: string; booking?: boolean; stage?: DealStage; skipCall?: boolean } = {}) {
  const b = await seedBusiness({ name: o.name ?? "Ace Plumbing" });
  await insertTestAudit(b.id);
  let deal = await createDeal(env.DB, { businessId: b.id, source: o.booking === false ? "manual" : "booking", skipCall: o.skipCall });
  if (o.booking !== false) {
    await insertBookingIfFree(env.DB, {
      businessId: b.id, dealId: deal.id, kind: "discovery", ...nextSlot(), contactName: "Pat Jones", contactEmail: "pat@acme.test",
      contactPhone: null, answers: { topic: "a new website", budgetId: "797-1999", timeline: "This month", decisionMaker: "me" }, source: "visitor",
    });
  }
  await saveNotes(env.DB, deal.id, NOTES);
  await saveOptions(env.DB, deal.id, offerOf(PROPOSAL_OPTIONS, await listCurrentPackages(env.DB)));
  deal = await moveDeal(env.DB, deal.id, o.stage ?? "recommended");
  return { businessId: b.id, dealId: deal.id, deal };
}

export const REVIEWED_CONFIG = JSON.stringify({ legalReviewedAt: "2026-11-01T00:00:00.000Z", legalReviewer: "A. Lawyer", lateFeePercentMonthly: 1.5, expiryDays: 30 });
export const OWNER_EMAIL = "logan@siteline.test";
const MAILBOX = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "logan@main.test", from_email: "logan@main.test", from_name: "Logan at Siteline",
};

/** Settings with the lawyer's review recorded, the main mailbox switched on, and a mail sender that records what it is given. Undo with `setMailDeps(null)`. */
export async function readyToSend(o: { reviewed?: boolean; mailbox?: boolean } = {}) {
  await saveSettings(env.DB, {
    your_name: "Logan Irish", business_name: "Siteline", contact_email: OWNER_EMAIL, signature: "Logan", signature_json: "",
    documents_config: o.reviewed === false ? "{}" : REVIEWED_CONFIG,
  });
  await saveMailbox(env.DB, "main", { ...MAILBOX, enabled: o.mailbox === false ? 0 : 1 });
  const mail = { sent: [] as OutboundMessage[], failures: [] as Error[] };
  setMailDeps({ smtp: async (_mb, _pw, msg) => { const f = mail.failures.shift(); if (f) throw f; mail.sent.push(msg); }, now: () => new Date(SENT_AT) });
  return mail;
}

/** A stand-in for the browser, for a test that signs a proposal (signing makes the PDF): real rendering needs the Browser Rendering binding. Undo with `setPdfRendererForTests(null)`. */
export function stubPdfRenderer() {
  setPdfRendererForTests(async () => new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]));
}
