import { listForDeal, type Document } from "../db/documents";
import {
  getAnswers, getOnboardingForDeal, listFiles, listItems,
  type Onboarding, type OnboardingFile, type OnboardingItem,
} from "../db/onboardings";
import type { Env } from "../env";
import { clientBase } from "../documents/mail";
import { onboardingLink } from "./link";
import { silentDays, stageOf, type Stage } from "./schedule";
import { questionsFor, type Question } from "./templates";

/** What the owner's onboarding panel reads and the checks on what the owner types there. */

/** The onboarding as the owner's browser gets it: everything but the token (the link is the one way in, and it is built here). */
export type OwnerOnboarding = Omit<Onboarding, "token">;
/** A file as listed to the owner: where it sits in storage is not sent (the download route finds it by id). */
export type OwnerFile = Omit<OnboardingFile, "r2Key">;
export type OwnerItem = OnboardingItem & { files: OwnerFile[] };

export interface OnboardingState {
  onboarding: OwnerOnboarding | null;
  stage: Stage | null;
  items: OwnerItem[];
  answers: Record<string, string>;
  questions: Question[];
  /** The client's link, for the owner only. Null when the client base is not set or the link is revoked. */
  link: string | null;
  /** The newest welcome approval for this onboarding, in any state. */
  welcomeApproval: { id: string; status: string } | null;
  silentDays: number;
  /** A real onboarding can be started now (a signed, paid, non-test proposal and none started yet). */
  canStart: boolean;
  /** A test onboarding can be started now (a signed test copy, no real proposal on the deal, and none started yet). */
  canStartTest: boolean;
}

export const ownerOnboarding = (o: Onboarding): OwnerOnboarding => {
  const { token: _token, ...rest } = o;
  return rest;
};
export const ownerFile = (f: OnboardingFile): OwnerFile => {
  const { r2Key: _key, ...rest } = f;
  return rest;
};

/** The deal's newest signed proposal: the real one (`paid`, not a test copy) or any. Documents come newest version first. */
export async function signedDocument(db: D1Database, dealId: string, real: boolean): Promise<Document | null> {
  const docs = await listForDeal(db, dealId);
  return docs.find((d) => d.status === "signed" && (!real || !d.test)) ?? null;
}

/** Why a test onboarding cannot be made on a deal that has a real proposal (a test one would block the real onboarding for good). */
export const REAL_PROPOSAL_PROBLEM = "This deal has a real proposal. Rehearse on a test lead instead.";

/** Whether the deal has a proposal that is not a test copy and has not been voided (a draft, sent, signed or expired one). */
export async function hasRealProposal(db: D1Database, dealId: string): Promise<boolean> {
  return (await listForDeal(db, dealId)).some((d) => !d.test && d.status !== "void");
}

/** The welcome approval that is the newest for this onboarding, whatever state it is in. */
export async function welcomeApprovalFor(db: D1Database, onboardingId: string): Promise<{ id: string; status: string } | null> {
  return await db.prepare(
    `SELECT id, status FROM approvals WHERE kind = 'onboarding.welcome' AND json_extract(payload, '$.onboardingId') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(onboardingId).first<{ id: string; status: string }>();
}

const EMPTY: Omit<OnboardingState, "canStart" | "canStartTest"> = {
  onboarding: null, stage: null, items: [], answers: {}, questions: [], link: null, welcomeApproval: null, silentDays: 0,
};

/** Everything the panel shows for a deal. With no onboarding yet it says whether one can be started. */
export async function onboardingState(env: Env, dealId: string, now: Date): Promise<OnboardingState> {
  const o = await getOnboardingForDeal(env.DB, dealId);
  if (!o) {
    const real = (await signedDocument(env.DB, dealId, true))?.paidAt ?? null;
    const signed = (await hasRealProposal(env.DB, dealId)) ? null : await signedDocument(env.DB, dealId, false);
    return { ...EMPTY, canStart: !!real, canStartTest: !!signed };
  }
  const [items, answers, approval] = await Promise.all([listItems(env.DB, o.id), getAnswers(env.DB, o.id), welcomeApprovalFor(env.DB, o.id)]);
  const withFiles = await Promise.all(items.map(async (i): Promise<OwnerItem> => ({ ...i, files: i.kind === "files" ? (await listFiles(env.DB, i.id)).map(ownerFile) : [] })));
  return {
    onboarding: ownerOnboarding(o), stage: stageOf(o, items, now), items: withFiles, answers, questions: questionsFor(o.kind),
    link: o.revokedAt ? null : onboardingLink(clientBase(env) ?? undefined, o.token), welcomeApproval: approval, silentDays: silentDays(o, now),
    canStart: false, canStartTest: false,
  };
}

/** The document a real start works from, or why there is none: it takes a paid, signed, non-test proposal with a contact email, and a client base to build the link on. */
export async function realStartProblem(env: Env, dealId: string): Promise<{ doc: Document } | { problem: string }> {
  const doc = await signedDocument(env.DB, dealId, true);
  if (!doc) return { problem: "There is no signed proposal for this deal yet (a test copy does not count)." };
  if (!doc.paidAt) return { problem: "The deposit has not been paid yet. The onboarding starts when it is." };
  return startableDoc(env, doc);
}

/** The same checks for a test start, which takes a signed test copy and only on a deal with no real proposal (one onboarding per deal: a test one would block the real one). */
export async function testStartProblem(env: Env, dealId: string): Promise<{ doc: Document } | { problem: string }> {
  if (await hasRealProposal(env.DB, dealId)) return { problem: REAL_PROPOSAL_PROBLEM };
  const doc = await signedDocument(env.DB, dealId, false);
  return doc ? startableDoc(env, doc) : { problem: "There is no signed proposal for this deal yet, so there is nothing to start an onboarding from." };
}

function startableDoc(env: Env, doc: Document): { doc: Document } | { problem: string } {
  if (!doc.content.header.contactEmail.trim()) return { problem: "The proposal has no contact email, so there is nobody to send the welcome to." };
  if (!clientBase(env)) return { problem: "Set CLIENT_LINK_BASE (an https address for client links) first: the welcome link is built on it." };
  return { doc };
}
