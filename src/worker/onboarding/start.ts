import { logActivityOnce } from "../db/activity";
import type { Document } from "../db/documents";
import type { Env } from "../env";
import { createOnboarding, type Onboarding } from "../db/onboardings";
import { createWelcomeApproval, hasWelcomeApproval } from "../approvals/onboardingWelcome";
import { clientBase } from "../documents/mail";
import { ensureSite } from "../sites/seed";
import { itemsFor, onboardingKindOf } from "./templates";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Says on the lead's timeline why no onboarding was started (once), because a payment that has gone through cannot fail over it. */
async function note(env: Env, doc: Document, reason: string): Promise<null> {
  await logActivityOnce(env.DB, doc.businessId, "note", `onboarding not started: ${oneLine(reason)}`)
    .catch((e) => console.error("onboarding: could not log why it was not started", e instanceof Error ? e.message : "unknown error"));
  return null;
}

/**
 * Starts the onboarding for a signed proposal: the checklist from the packages the document froze, and one welcome mail waiting for approval. Safe to
 * repeat: the deal has one onboarding, its start is logged once, and a welcome that is already waiting, decided or sent is not asked for again.
 * Returns null, with a note on the lead's timeline, when it cannot be started (the proposal is not signed, there is no contact email, there is no client
 * link base to build the link on). It never throws: it runs inside the payment path, which must go on whatever happens here.
 */
export async function startOnboarding(env: Env, doc: Document, o: { test?: boolean } = {}): Promise<Onboarding | null> {
  try {
    if (doc.status !== "signed") return await note(env, doc, `the proposal is ${doc.status}, not signed`);
    if (!doc.content.header.contactEmail.trim()) return await note(env, doc, "the proposal has no contact email");
    if (!clientBase(env)) return await note(env, doc, "CLIENT_LINK_BASE is not set (an https address for client links), so the welcome link cannot be made");

    const keys = doc.content.packages.map((p) => p.key);
    const kind = onboardingKindOf(keys);
    // A test copy is a test whatever the caller says: it must never mail the contact on the document.
    const test = !!(o.test || doc.test);
    const { onboarding } = await createOnboarding(env.DB, {
      businessId: doc.businessId, dealId: doc.dealId, documentId: doc.id, kind, test, items: itemsFor(keys),
    });
    // The site record for this sale. It never throws and its result is not part of what this returns: a failed seed is logged and the next start tries again.
    await ensureSite(env.DB, { businessId: doc.businessId, packageKeys: keys, test });
    // A deal has one onboarding. If a test one got there first, a real start has not happened: say so rather than report the test row as the client's.
    if (!test && onboarding.test) return await note(env, doc, "a test onboarding already exists on this deal; the real one was not started");
    await logActivityOnce(env.DB, doc.businessId, "onboarding_started", `${doc.content.header.reference} v${doc.version}: ${onboarding.kind} onboarding started${onboarding.test ? " (test)" : ""}`);
    if (!onboarding.welcomeSentAt && !(await hasWelcomeApproval(env.DB, onboarding.id))) await createWelcomeApproval(env, onboarding);
    return onboarding;
  } catch (e) {
    console.error("onboarding: not started", e instanceof Error ? e.message : "unknown error");
    return await note(env, doc, e instanceof Error ? e.message : "unknown error");
  }
}
