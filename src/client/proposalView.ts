import type { Deal } from "../worker/db/deals";
import type { Document } from "../worker/db/documents";
import { DEFAULT_ASSUMPTIONS, DEFAULT_OUT_OF_SCOPE, type ProposalEdits } from "../worker/documents/proposal";

type StepDoc = Pick<Document, "status" | "sentAt" | "firstViewedAt" | "signedAt" | "paidAt" | "voidReason" | "expiresAt">;
export interface ProposalStep { label: string; at: string | null; done: boolean }

/**
 * The life of a proposal as a short list: drafted, sent, viewed, signed, deposit paid. Each step is done once it has a time (a draft is always drafted).
 * A void or expired document keeps the steps that happened and ends in one line (why it was voided, or when it expired) instead of the steps that never will.
 */
export function proposalSteps(doc: StepDoc): ProposalStep[] {
  const steps: ProposalStep[] = [
    { label: "Drafted", at: null, done: true },
    { label: "Sent", at: doc.sentAt, done: !!doc.sentAt },
    { label: "Viewed", at: doc.firstViewedAt, done: !!doc.firstViewedAt },
    { label: "Signed", at: doc.signedAt, done: !!doc.signedAt },
    { label: "Deposit paid", at: doc.paidAt, done: !!doc.paidAt },
  ];
  if (doc.status === "void") return [...steps.filter((s) => s.done), { label: `Voided: ${doc.voidReason ?? "no reason given"}`, at: null, done: true }];
  if (doc.status === "expired") return [...steps.filter((s) => s.done), { label: "Expired", at: doc.expiresAt, done: true }];
  return steps;
}

/** What stops a draft from going for approval, in the order to fix it. Empty when it can go. */
export function sendBlockers(g: { legalGate: string | null; clientBase: string | null; doc: Document }): string[] {
  const out: string[] = [];
  if (g.legalGate) out.push(g.legalGate);
  if (!g.clientBase) out.push("Set CLIENT_LINK_BASE (an https address for client links) before sending.");
  if (g.doc.status !== "draft") out.push("Only a draft can be sent. Void this version to start a new one.");
  if (g.doc.test) out.push("This is a test copy. Void it and make a new draft to send for real.");
  return out;
}

/** The proposal form on the Deal page. The lists are one entry per line. */
export interface ProposalForm {
  optionId: "a" | "b" | "c"; scopeNotes: string; extraAssumptions: string; extraOutOfScope: string; careDeclined: boolean; contactName: string; contactEmail: string;
}
export interface ProposalDefaults { recommendedOptionId: Deal["recommendedOptionId"]; contact: { name: string; email: string } | null }

const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** The form as it stands for a deal: the working document's own values when it has one, otherwise the recommended option and the person who booked the call. */
export function formOf(current: Document | null, d: ProposalDefaults): ProposalForm {
  if (current) {
    const c = current.content;
    return {
      optionId: c.optionId, scopeNotes: c.scopeNotes, extraAssumptions: c.assumptions.slice(DEFAULT_ASSUMPTIONS.length).join("\n"),
      extraOutOfScope: c.outOfScope.slice(DEFAULT_OUT_OF_SCOPE.length).join("\n"), careDeclined: c.careDeclined, contactName: c.header.contactName, contactEmail: c.header.contactEmail,
    };
  }
  return { optionId: d.recommendedOptionId ?? "b", scopeNotes: "", extraAssumptions: "", extraOutOfScope: "", careDeclined: false, contactName: d.contact?.name ?? "", contactEmail: d.contact?.email ?? "" };
}

/** What the server builds the proposal from. */
export const editsOf = (f: ProposalForm): ProposalEdits => ({
  scopeNotes: f.scopeNotes.trim(), extraAssumptions: lines(f.extraAssumptions), extraOutOfScope: lines(f.extraOutOfScope), careDeclined: f.careDeclined,
});

/** The contact to send, or null to let the server use the person who booked the call (both fields blank). One field alone is not a contact. */
export function contactOf(f: ProposalForm): { name: string; email: string } | null | "incomplete" {
  const name = f.contactName.trim(), email = f.contactEmail.trim();
  if (!name && !email) return null;
  return name && email ? { name, email } : "incomplete";
}

/** Whether the typed form differs from what is saved (so a send waits for a save, and closing the page asks first). */
export const isProposalDirty = (f: ProposalForm, current: Document | null, d: ProposalDefaults): boolean =>
  JSON.stringify(normalised(f)) !== JSON.stringify(normalised(formOf(current, d)));
const normalised = (f: ProposalForm) => ({ ...f, scopeNotes: f.scopeNotes.trim(), extraAssumptions: lines(f.extraAssumptions), extraOutOfScope: lines(f.extraOutOfScope), contactName: f.contactName.trim(), contactEmail: f.contactEmail.trim() });
