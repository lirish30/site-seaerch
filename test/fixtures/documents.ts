import { env } from "cloudflare:test";
import { createDeal } from "../../src/worker/db/deals";
import { sha256Hex, canonicalJson } from "../../src/worker/documents/hash";
import { newClientToken } from "../../src/worker/documents/token";
import { markSent, type SignatureRecord } from "../../src/worker/db/documents";
import type { ProposalContent } from "../../src/worker/documents/proposal";
import { seedBusiness } from "./cro";

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
