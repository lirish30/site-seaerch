import { createExecutionContext, env } from "cloudflare:test";
import { expect } from "vitest";
import worker from "../../src/worker/index";
import { approve } from "../../src/worker/approvals/decide";
import { createSendApproval } from "../../src/worker/approvals/proposalSend";
import { getDeal } from "../../src/worker/db/deals";
import { getDocument } from "../../src/worker/db/documents";
import { setStripeFetchForTests } from "../../src/worker/documents/deposit";
import { proposalPage, signProposal } from "../../src/worker/documents/public";
import { draftProposal } from "../../src/worker/documents/service";
import type { Env } from "../../src/worker/env";
import { seedProposalDeal } from "./documents";
import { KEY, SECRET, sign, stripeApi } from "./stripe";

/** The close, driven through the entry points the app really uses (shared by the close and onboarding flow tests). Fakes for Stripe, mail and the PDF browser are the caller's to set up. */
export const NOW = new Date("2026-12-01T17:00:00.000Z");
export const SIGNED_AT = new Date("2026-12-02T09:00:00.000Z");
/** The Worker's bindings with the Stripe secrets the webhook and the deposit read. */
export const E = { ...env, STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET } as Env;

/** Delivers a signed event to the public webhook the way Stripe does. */
export async function deliver(event: unknown): Promise<number> {
  const body = JSON.stringify(event);
  const res = await worker.fetch(new Request("https://x/hooks/stripe", { method: "POST", body, headers: { "stripe-signature": await sign(body) } }), E, createExecutionContext());
  return res.status;
}

/** A deal at `recommended`, drafted, approved for sending, opened by the client and signed by them: everything up to the payment. */
export async function signedDeal(o: { name?: string } = {}) {
  const api = stripeApi();
  setStripeFetchForTests(api.f);
  const s = await seedProposalDeal({ name: o.name });
  const draft = await draftProposal(E, s.dealId, { optionId: "b", edits: { scopeNotes: "A new site." } }, NOW);
  const approval = await createSendApproval(E, draft);
  expect(await approve(E, approval.id)).toEqual({ ok: true });
  const sent = (await getDocument(env.DB, draft.id))!;
  expect(sent.status).toBe("sent");
  expect((await getDeal(env.DB, s.dealId))!.stage).toBe("proposal_sent");

  const page = await proposalPage(E, sent.token!, { now: SIGNED_AT, userAgent: "TestBrowser/1.0" });
  expect(page).toMatchObject({ state: "open", contentSha256: sent.contentSha256 });
  expect((await getDocument(env.DB, draft.id))!.status).toBe("viewed");

  const signed = await signProposal(E, sent.token!, { name: "Pat Jones", consent: true, authority: true, sha256: sent.contentSha256 }, { now: SIGNED_AT, ip: "203.0.113.9", userAgent: "TestBrowser/1.0" });
  expect(signed.ok).toBe(true);
  return { ...s, api, approval, docId: draft.id, token: sent.token! };
}
