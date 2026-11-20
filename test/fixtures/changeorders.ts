import { env } from "cloudflare:test";
import { createChangeOrderDraft, markSent, type ChangeOrder, type ChangeOrderContent } from "../../src/worker/db/changeOrders";
import { sealChangeOrder } from "../../src/worker/changeorders/service";
import { getSettings } from "../../src/worker/db/settings";
import { newClientToken } from "../../src/worker/documents/token";
import { canonicalJson, sha256Hex } from "../../src/worker/documents/hash";
import { seedProject } from "./projects";

export const NOW_ISO = "2026-12-05T10:00:00.000Z";
export const FAR = "2099-01-01T00:00:00.000Z";

/** The content a change order is made from (everything but the reference, which the number gives). */
export const content = (o: Partial<Omit<ChangeOrderContent, "reference">> = {}): Omit<ChangeOrderContent, "reference"> => ({
  title: "Add a gallery page", summary: "A page of twelve job photos.", reason: "The client asked for it after launch planning.", deliverables: [], notIncluded: [], hours: 2,
  rateCents: 12500, priceCents: 25000, scheduleImpactDays: null, clientName: "Ace Plumbing", contactName: "Pat Jones", contactEmail: "pat@ace.test", ...o,
});

/** A project with its lead and (draft) document, and a bare change-order row on it. Use the service's `draftChangeOrder` for the full path. */
export async function seedOrder(o: { test?: boolean; content?: Partial<Omit<ChangeOrderContent, "reference">>; originApprovalId?: string } = {}) {
  const s = await seedProject({ test: o.test });
  const { changeOrder } = await createChangeOrderDraft(env.DB, {
    projectId: s.project.id, businessId: s.businessId, dealId: s.dealId, test: o.test ?? false, sourceType: "logan", originApprovalId: o.originApprovalId ?? null,
    referenceBase: "SL-ABCDEF", content: content(o.content),
  });
  return { ...s, co: changeOrder };
}

/** Sends a draft the way the approval will, with a far-off expiry unless one is given. Returns the order and the hash the client sees. */
export async function sendOrder(co: ChangeOrder, o: { approvalId?: string | null; expiresAt?: string; sentAt?: string } = {}) {
  const hash = await sha256Hex(canonicalJson(co.content));
  const sent = await markSent(env.DB, co.id, {
    token: newClientToken(), content: co.content, contentSha256: hash, sentAt: o.sentAt ?? NOW_ISO, expiresAt: o.expiresAt ?? FAR, approvalId: o.approvalId === undefined ? null : o.approvalId,
  });
  return { co: sent, hash };
}

export const clientSig = (hash: string, o: { signedAt?: string } = {}) => ({
  signerName: "Pat Jones", signerEmail: "pat@ace.test", signedAt: o.signedAt ?? "2026-12-06T09:00:00.000Z", ip: "203.0.113.9", userAgent: "TestBrowser/1.0",
  consentText: "I agree to sign electronically.", consentVersion: 1, contentSha256: hash,
});

/** Seals a draft with the real service (token, hash, expiry from the settings). */
export async function seal(co: ChangeOrder, now = new Date(NOW_ISO)) {
  return sealChangeOrder(env as never, co, { now, approvalId: null, settings: await getSettings(env.DB) });
}
