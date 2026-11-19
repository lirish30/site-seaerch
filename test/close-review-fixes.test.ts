import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getDeal, moveDeal } from "../src/worker/db/deals";
import { createDraft, getDocument, listForDeal, recordView, setPdf, signaturesFor, signDocument, voidDocument } from "../src/worker/db/documents";
import { legalGate, parseDocumentsConfig, showDraftBanner } from "../src/worker/documents/config";
import { proposalPage, signProposal } from "../src/worker/documents/public";
import { draftProposal, sendTest, voidOpenProposals } from "../src/worker/documents/service";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { approve } from "../src/worker/approvals/decide";
import { createSendApproval } from "../src/worker/approvals/proposalSend";
import { renderProposalHtml } from "../src/worker/documents/render";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { retrieveInvoice } from "../src/worker/stripe/client";
import { OWNER_EMAIL, clientSig, proposal, readyToSend, seedDeal, seedProposalDeal, sendDraft, stubPdfRenderer } from "./fixtures/documents";
import { KEY } from "./fixtures/stripe";

// The fixes from the whole-branch review of Plan 5: each test names the finding it covers.
const NOW = new Date("2026-12-01T17:00:00.000Z");
const SIGNED_AT = new Date("2026-12-02T09:00:00.000Z");
const FAR = "2099-01-01T00:00:00.000Z";
const E = env as Env;

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); mail = await readyToSend(); stubPdfRenderer(); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); setPdfRendererForTests(null); });

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const form = (hash: string, name = "Pat Jones") => ({ name, consent: true, authority: true, sha256: hash });
const signAs = (e: Env, token: string, hash: string, name?: string) => signProposal(e, token, form(hash, name), { now: SIGNED_AT, ip: "203.0.113.9", userAgent: "TestBrowser/1.0" });
const kinds = async (businessId: string) => (await listActivity(env.DB, businessId, 200)).map((a) => a.kind);

/** A deal with a real proposal sent through the approval (the deal is at proposal_sent). */
async function sentDeal() {
  const s = await seedProposalDeal();
  const draft = await draftProposal(E, s.dealId, { optionId: "b", edits: { scopeNotes: "A new site." } }, NOW);
  expect(await approve(E, (await createSendApproval(E, draft)).id)).toEqual({ ok: true });
  const doc = (await getDocument(env.DB, draft.id))!;
  return { ...s, doc, token: doc.token!, hash: doc.contentSha256! };
}

/** A test copy sent to the owner, still unsigned. */
async function testCopy() {
  const s = await seedProposalDeal();
  const draft = await draftProposal(E, s.dealId, { optionId: "b", edits: {}, test: true }, NOW);
  const doc = await sendTest(E, draft, NOW);
  return { ...s, doc, token: doc.token!, hash: doc.contentSha256! };
}

describe("I1: signing a test copy", () => {
  it("a signed test copy can be voided and a real proposal drafted after it", async () => {
    const s = await testCopy();
    expect((await signAs(E, s.token, s.hash)).ok).toBe(true);
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");

    // A signed test copy does not block a new draft, and it can be voided; its signature rows stay.
    const real = await draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW);
    expect(real).toMatchObject({ status: "draft", test: false });
    const voided = await voidDocument(env.DB, s.doc.id, "just a rehearsal");
    expect(voided.status).toBe("void");
    expect((await signaturesFor(env.DB, s.doc.id)).map((x) => x.role).sort()).toEqual(["client", "provider"]);
    expect((await listForDeal(env.DB, s.dealId)).map((d) => d.status).sort()).toEqual(["draft", "void"]);
  });

  it("a signed REAL proposal still blocks a new draft and cannot be voided", async () => {
    const s = await sentDeal();
    expect((await signAs(E, s.token, s.hash)).ok).toBe(true);
    await expect(draftProposal(E, s.dealId, { optionId: "b", edits: {} }, NOW)).rejects.toThrow(/already signed/);
    await expect(voidDocument(env.DB, s.doc.id, "no")).rejects.toThrow(/cannot be voided/);
    await expect(createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() })).rejects.toThrow(/sent or signed/);
  });

  it("the owner can void a signed test copy through the route", async () => {
    const s = await testCopy();
    await signAs(E, s.token, s.hash);
    const res = await SELF.fetch(`https://x/api/documents/${s.doc.id}/void`, { method: "POST", body: JSON.stringify({ reason: "rehearsal" }), headers: { cookie, "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("void");
  });

  it("signing a test copy mails nobody but the owner, and the notice says it is a test", async () => {
    const s = await testCopy();
    const before = mail.sent.length; // the test send itself went to the owner
    expect((await signAs(E, s.token, s.hash)).ok).toBe(true);
    const after = mail.sent.slice(before);
    expect(after.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(after[0].subject).toMatch(/^\[Test\]/);
    expect(mail.sent.some((m) => m.to === "pat@acme.test")).toBe(false);
  });
});

describe("I2: a lost deal has no live proposal", () => {
  it("moving a deal to lost voids its sent proposal, logs it, and the link shows the closed page", async () => {
    const s = await sentDeal();
    const res = await SELF.fetch(`https://x/api/deals/${s.dealId}/move`, { method: "POST", body: JSON.stringify({ to: "lost", lostReason: "went with a cousin" }), headers: { cookie, "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ status: "void", voidReason: "the deal was marked lost" });
    expect(await kinds(s.businessId)).toContain("proposal_void");
    expect(await proposalPage(E, s.token, { now: SIGNED_AT, userAgent: null })).toMatchObject({ state: "closed" });
    expect(await signAs(E, s.token, s.hash)).toEqual({ ok: false, status: 409, error: "this proposal is no longer open" });
  });

  it("a lost deal whose proposal is somehow still open refuses to sign and shows closed", async () => {
    const s = await sentDeal();
    await moveDeal(env.DB, s.dealId, "lost", { lostReason: "no budget" }); // the document is untouched: the guard must hold on its own
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("sent");
    expect(await signAs(E, s.token, s.hash)).toMatchObject({ ok: false, status: 409 });
    expect(await proposalPage(E, s.token, { now: SIGNED_AT, userAgent: null })).toMatchObject({ state: "closed" });
    expect(await signaturesFor(env.DB, s.doc.id)).toHaveLength(1); // only the provider's
  });

  it("a deal that is won by something else refuses a second proposal's signature, but a signed one stays signed", async () => {
    const s = await sentDeal();
    expect((await signAs(E, s.token, s.hash)).ok).toBe(true);
    await env.DB.prepare(`UPDATE deals SET stage = 'lost' WHERE id = ?`).bind(s.dealId).run();
    // A signed document is a record: asking again answers with it.
    expect(await signAs(E, s.token, s.hash)).toMatchObject({ ok: true, page: { state: "signed" } });
  });

  it("voidOpenProposals leaves a signed proposal alone", async () => {
    const s = await sentDeal();
    await signAs(E, s.token, s.hash);
    expect(await voidOpenProposals(env.DB, s.dealId, "x")).toBe(0);
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");
  });
});

describe("M1: a read that fails after the signature is stored", () => {
  it("still answers signed, and the signature stands", async () => {
    const s = await sentDeal();
    let armed = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (/UPDATE documents SET status = 'signed'/.test(sql)) armed = true;
          if (armed && /^SELECT \* FROM documents WHERE id = \?/.test(sql)) throw new Error("D1 hiccup");
          return target.prepare(sql);
        };
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const r = await signAs({ ...env, DB: db } as Env, s.token, s.hash);
    expect(r).toMatchObject({ ok: true, page: { state: "signed", signed: { name: "Pat Jones" }, contentSha256: s.hash } });
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");
    expect((await signaturesFor(env.DB, s.doc.id)).filter((x) => x.role === "client")).toHaveLength(1);
  });
});

describe("M4: the draft banner", () => {
  const gate = legalGate(parseDocumentsConfig("{}"))!;
  it("showDraftBanner: a test copy always, an unsigned document while the review is missing, a signed real one never", () => {
    for (const status of ["draft", "sent", "viewed", "void", "expired", "signed"]) {
      expect(showDraftBanner({ test: true, status }, null), `test ${status}`).toBe(true);
      expect(showDraftBanner({ test: true, status }, gate), `test ${status} gated`).toBe(true);
      expect(showDraftBanner({ test: false, status }, null), `real ${status}`).toBe(false);
      expect(showDraftBanner({ test: false, status }, gate), `real ${status} gated`).toBe(status !== "signed");
    }
  });
});

describe("M5: the client page cannot be framed", () => {
  it("public/_headers forbids framing on /p and /p/*", async () => {
    const text = await (await import("../public/_headers?raw")).default as string;
    const blocks = text.split(/\n(?=\S)/).filter((b) => b.startsWith("/p"));
    expect(blocks.map((b) => b.split("\n")[0].trim())).toEqual(["/p", "/p/*"]);
    for (const b of blocks) { expect(b).toContain("X-Frame-Options: DENY"); expect(b).toContain("Content-Security-Policy: frame-ancestors 'none'"); }
  });
});

describe("M8: the audit page's email label", () => {
  it("the client's email is labelled as the address the link was sent to", async () => {
    const content = proposal();
    const html = renderProposalHtml(content, {
      mode: "pdf", status: "signed", contentSha256: "a".repeat(64), auditPage: true, draftBanner: false,
      signatures: [
        { id: "1", documentId: "d", role: "provider", ...clientSig("a".repeat(64)), signerName: "Pat Provider", signerEmail: "hello@siteline.test" },
        { id: "2", documentId: "d", role: "client", ...clientSig("a".repeat(64)) },
      ],
    });
    expect(html).toContain("<th>Email the link was sent to</th><td>pat@ace.test</td>");
    expect(html).toContain("<th>Email</th><td>hello@siteline.test</td>");
  });
});

describe("M10: the timeline shows when the client first opened the proposal", () => {
  it("one proposal_viewed on the first view only, never for a test copy", async () => {
    const s = await sentDeal();
    const open = () => proposalPage(E, s.token, { now: SIGNED_AT, userAgent: "TestBrowser/1.0" });
    await open();
    await open();
    await proposalPage(E, s.token, { now: new Date(SIGNED_AT.getTime() + 3_600_000), userAgent: "TestBrowser/1.0" });
    const viewed = (await listActivity(env.DB, s.businessId, 200)).filter((a) => a.kind === "proposal_viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0].detail).toContain("version 1");

    const t = await testCopy();
    await proposalPage(E, t.token, { now: SIGNED_AT, userAgent: null });
    expect(await kinds(t.businessId)).not.toContain("proposal_viewed");
  });

  it("recordView answers true only for the visit that moved sent to viewed", async () => {
    const s = await seedDeal();
    const d = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    const { doc } = await sendDraft(d.id, proposal(), { expiresAt: FAR });
    expect(await recordView(env.DB, doc.id, { now: SIGNED_AT.toISOString(), userAgent: null })).toBe(true);
    expect(await recordView(env.DB, doc.id, { now: new Date(SIGNED_AT.getTime() + 3_600_000).toISOString(), userAgent: null })).toBe(false);
  });
});

describe("M11: a PDF failure never sits beside a stored PDF", () => {
  it("an error is recorded while there is no file, and ignored once there is one", async () => {
    const s = await seedDeal();
    const d = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
    const { doc, hash } = await sendDraft(d.id, proposal(), { expiresAt: FAR });
    await signDocument(env.DB, doc.id, clientSig(hash), SIGNED_AT.toISOString());
    await setPdf(env.DB, doc.id, { error: "first try failed" });
    expect((await getDocument(env.DB, doc.id))!.pdfError).toBe("first try failed");
    await setPdf(env.DB, doc.id, { key: "documents/x/signed.pdf", sha256: "b".repeat(64) });
    expect(await getDocument(env.DB, doc.id)).toMatchObject({ pdfKey: "documents/x/signed.pdf", pdfError: null });
    await setPdf(env.DB, doc.id, { error: "a slower attempt failed" });
    expect(await getDocument(env.DB, doc.id)).toMatchObject({ pdfKey: "documents/x/signed.pdf", pdfError: null });
  });
});

describe("M7: Stripe calls time out", () => {
  it("a call passes a timeout signal, and a timeout is a StripeError that says so", async () => {
    let seen: AbortSignal | null | undefined;
    const hang = async (_url: string, init?: RequestInit) => {
      seen = init?.signal;
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    };
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), 5); expect(ms).toBe(15_000); return c.signal; });
    try {
      await expect(retrieveInvoice(hang, KEY, "in_1")).rejects.toMatchObject({ name: "StripeError", message: "Stripe did not respond" });
    } finally { spy.mockRestore(); }
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe("the signer's name on the timeline", () => {
  it("is cut to 60 characters in the activity detail, whole on the signature row", async () => {
    const s = await sentDeal();
    const long = `Pat ${"Jones ".repeat(15)}`.trim();
    expect(long.length).toBeGreaterThan(60);
    expect((await signAs(E, s.token, s.hash, long)).ok).toBe(true);
    const signed = (await listActivity(env.DB, s.businessId, 200)).find((a) => a.kind === "proposal_signed")!;
    expect(signed.detail).toBe(`Signed by ${long.slice(0, 60)} (version 1)`);
    expect((await signaturesFor(env.DB, s.doc.id)).find((x) => x.role === "client")!.signerName).toBe(long);
  });
});
