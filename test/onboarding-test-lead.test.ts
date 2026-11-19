import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOnboarding } from "../src/worker/db/onboardings";
import { DocumentStateError, getDocument, listForDeal } from "../src/worker/db/documents";
import { getSettings } from "../src/worker/db/settings";
import { TEST_ONBOARDING_PROBLEM, draftProposal, sealProposal, sendProblems, sendTest } from "../src/worker/documents/service";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { readyToSend, seedProposalDeal } from "./fixtures/documents";

// A test onboarding owns its deal's one onboarding slot for good, so a real proposal must never be drafted or sent on such a deal.
const E = env as Env;
const NOW = new Date("2026-12-01T17:00:00.000Z");
const MESSAGE = "This deal has a test onboarding, so a real proposal cannot be sent on it. Use a new test lead for rehearsals.";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });
beforeEach(async () => { await readyToSend(); });
afterEach(() => setMailDeps(null));

/** A deal at `recommended`; with `testOnboarding`, one that already has a test onboarding hanging off a draft test copy. */
async function deal(o: { testOnboarding?: boolean } = {}) {
  const s = await seedProposalDeal();
  if (o.testOnboarding) {
    const copy = await draftProposal(E, s.dealId, { optionId: "b", edits: {}, test: true }, NOW);
    await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: copy.id, kind: "build", test: true, items: [] });
  }
  return s;
}

describe("a deal with a test onboarding", () => {
  it("the message is the one the owner is shown", () => {
    expect(TEST_ONBOARDING_PROBLEM).toBe(MESSAGE);
  });

  it("refuses to draft a real proposal (a 409 on the route), and nothing is made", async () => {
    const s = await deal({ testOnboarding: true });
    const before = (await listForDeal(env.DB, s.dealId)).length;
    await expect(draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toThrow(DocumentStateError);
    await expect(draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toThrow(MESSAGE);
    const res = await call("POST", `/api/deals/${s.dealId}/proposal`, { optionId: "b", edits: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MESSAGE });
    expect((await listForDeal(env.DB, s.dealId)).length).toBe(before);
  });

  it("still allows a test copy", async () => {
    const s = await deal({ testOnboarding: true });
    const doc = await draftProposal(E, s.dealId, { optionId: "b", edits: {}, test: true }, NOW);
    expect(doc).toMatchObject({ status: "draft", test: true });
    const sent = await sendTest(E, doc, NOW);
    expect(sent).toMatchObject({ status: "sent", test: true });
  });

  it("refuses to send a real draft made before the test onboarding: no approval, and sealing is refused too", async () => {
    const s = await deal();
    const real = await draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW);
    expect(await sendProblems(E, real)).toEqual([]);
    // The owner now rehearses on this deal, which he was told not to.
    await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: real.id, kind: "build", test: true, items: [] });

    expect((await sendProblems(E, real))[0]).toBe(MESSAGE);
    const res = await call("POST", `/api/documents/${real.id}/send`);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toBe(MESSAGE);
    expect(body.approvalId).toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'proposal.send' AND json_extract(payload, '$.documentId') = ?`).bind(real.id).first<{ n: number }>())!.n).toBe(0);
    await expect(sealProposal(E, real, { now: NOW, approvalId: null, test: false, settings: await getSettings(env.DB) })).rejects.toThrow(MESSAGE);
    expect((await getDocument(env.DB, real.id))!.status).toBe("draft");
  });
});

describe("a deal with no onboarding, or a real one", () => {
  it("drafts and sends as before", async () => {
    const s = await deal();
    const real = await draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW);
    expect(await sendProblems(E, real)).toEqual([]);
    const res = await call("POST", `/api/documents/${real.id}/send`);
    expect(res.status).toBe(200);
  });

  it("a real onboarding does not stop a new draft on its deal", async () => {
    const s = await deal();
    const real = await draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW);
    await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: real.id, kind: "build", test: false, items: [] });
    expect(await sendProblems(E, real)).toEqual([]);
  });
});
