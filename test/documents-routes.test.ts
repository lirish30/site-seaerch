import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getDeal } from "../src/worker/db/deals";
import { getDocument, listForDeal } from "../src/worker/db/documents";
import { setMailDeps } from "../src/worker/mail/deps";
import { saveSettings } from "../src/worker/db/settings";
import { PROPOSAL_CSP } from "../src/worker/documents/render";
import { OWNER_EMAIL, readyToSend, seedProposalDeal } from "./fixtures/documents";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });

let mail: Awaited<ReturnType<typeof readyToSend>>;
beforeEach(async () => { mail = await readyToSend(); });
afterEach(() => setMailDeps(null));

const draft = async (s: { dealId: string }, body: Record<string, unknown> = {}) => {
  const res = await call("POST", `/api/deals/${s.dealId}/proposal`, { optionId: "b", edits: { scopeNotes: "A new site." }, ...body });
  return { res, doc: res.status === 200 || res.status === 201 ? await res.clone().json<any>() : null };
};

describe("/api/deals/:id/proposal", () => {
  it("requires sign-in", async () => {
    expect((await call("GET", "/api/deals/x/proposal", undefined, false)).status).toBe(401);
    expect((await call("POST", "/api/documents/x/send", undefined, false)).status).toBe(401);
    expect((await call("GET", "/api/documents/x/preview.html", undefined, false)).status).toBe(401);
  });

  it("reads the current document, the history, the gate, the client base and the contact to start from", async () => {
    const s = await seedProposalDeal();
    const empty = await (await call("GET", `/api/deals/${s.dealId}/proposal`)).json<any>();
    expect(empty).toMatchObject({ current: null, history: [], legalGate: null, clientBase: "https://clients.hellositeline.test", defaultContact: { name: "Pat Jones", email: "pat@acme.test" } });
    const { doc } = await draft(s);
    const got = await (await call("GET", `/api/deals/${s.dealId}/proposal`)).json<any>();
    expect(got.current.id).toBe(doc.id);
    expect(got.history.map((d: any) => d.id)).toEqual([doc.id]);
    await saveSettings(env.DB, { documents_config: "{}" });
    expect((await (await call("GET", `/api/deals/${s.dealId}/proposal`)).json<any>()).legalGate).toMatch(/Oregon lawyer/);
    expect((await call("GET", "/api/deals/nope/proposal")).status).toBe(404);
  });

  it("makes a draft, and a second draft request replaces the draft", async () => {
    const s = await seedProposalDeal();
    const a = await draft(s);
    expect(a.res.status).toBe(201);
    expect(a.doc).toMatchObject({ status: "draft", version: 1, optionId: "b" });
    const b = await draft(s, { optionId: "c", edits: { extraAssumptions: ["Parking is free."] } });
    expect(b.res.status).toBe(201);
    expect(b.doc).toMatchObject({ version: 1, optionId: "c" });
    expect(b.doc.content.assumptions).toContain("Parking is free.");
    expect(b.doc.content.header.version).toBe(b.doc.version);
    const all = await listForDeal(env.DB, s.dealId);
    expect(all).toHaveLength(1);
    expect(all[0].optionId).toBe("c");
  });

  it("validates the body and refuses what cannot be built", async () => {
    const s = await seedProposalDeal();
    expect((await draft(s, { optionId: "z" })).res.status).toBe(400);
    expect((await draft(s, { edits: { scopeNotes: "x".repeat(4001) } })).res.status).toBe(400);
    expect((await draft(s, { edits: { extraAssumptions: Array.from({ length: 21 }, () => "x") } })).res.status).toBe(400);
    expect((await draft(s, { contact: { name: "x".repeat(201), email: "a@b.test" } })).res.status).toBe(400);
    expect((await draft(s, { contact: { name: "Pat", email: "not an email" } })).res.status).toBe(400);
    expect((await draft(s, { extra: 1 })).res.status).toBe(400);
    const none = await seedProposalDeal({ booking: false });
    const refused = await draft(none);
    expect(refused.res.status).toBe(422);
    expect((await refused.res.json<any>()).error).toMatch(/no email/i);
    expect((await call("POST", "/api/deals/nope/proposal", { optionId: "b", edits: {} })).status).toBe(404);
  });

  it("a deal with a sent proposal is a 409 until it is voided", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    await call("POST", `/api/documents/${doc.id}/test-send`);
    const again = await draft(s);
    expect(again.res.status).toBe(409);
    expect((await call("POST", `/api/documents/${doc.id}/void`, { reason: "done testing" })).status).toBe(200);
    const next = await draft(s);
    expect(next.res.status).toBe(201);
    expect(next.doc.version).toBe(2);
  });
});

describe("/api/documents/:id", () => {
  it("saves edits to a draft, and refuses them on a sent document", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    const res = await call("PUT", `/api/documents/${doc.id}`, { edits: { scopeNotes: "Changed.", extraOutOfScope: ["Photos."], careDeclined: false } });
    expect(res.status).toBe(200);
    const updated = await res.json<any>();
    expect(updated).toMatchObject({ id: doc.id, version: 1 });
    expect(updated.content.scopeNotes).toBe("Changed.");
    expect(updated.content.outOfScope).toContain("Photos.");
    expect(updated.content.header.contactEmail).toBe("pat@acme.test");
    expect((await call("PUT", `/api/documents/${doc.id}`, { edits: { scopeNotes: "x".repeat(4001) } })).status).toBe(400);
    expect((await call("PUT", "/api/documents/nope", { edits: {} })).status).toBe(404);
    await call("POST", `/api/documents/${doc.id}/test-send`);
    expect((await call("PUT", `/api/documents/${doc.id}`, { edits: { scopeNotes: "sneaky" } })).status).toBe(409);
    expect((await getDocument(env.DB, doc.id))!.content.scopeNotes).toBe("Changed.");
  });

  it("preview carries the CSP and the draft banner", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s, { contact: { name: "<script>alert(1)</script>", email: "pat@acme.test" } });
    const res = await call("GET", `/api/documents/${doc.id}/preview.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(PROPOSAL_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("DRAFT");
    expect(html).toContain("Ace Plumbing");
    expect(html).not.toContain("<script>alert(1)");
    expect((await call("GET", "/api/documents/nope/preview.html")).status).toBe(404);
  });

  it("send creates the approval and says what would stop it", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    const res = await call("POST", `/api/documents/${doc.id}/send`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.problems).toEqual([]);
    const a = await env.DB.prepare(`SELECT kind, status FROM approvals WHERE id = ?`).bind(body.approvalId).first();
    expect(a).toMatchObject({ kind: "proposal.send", status: "pending" });
    expect((await (await call("POST", `/api/documents/${doc.id}/send`)).json<any>()).approvalId).toBe(body.approvalId);
    // Nothing has gone out: the approval is the owner's countersignature.
    expect(mail.sent).toEqual([]);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");

    await saveSettings(env.DB, { documents_config: "{}" });
    const blocked = await call("POST", `/api/documents/${doc.id}/send`);
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).problems.join(" ")).toMatch(/Oregon lawyer/);
  });

  it("test-send mails only the owner's address and leaves the deal alone", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    await saveSettings(env.DB, { documents_config: "{}" }); // a test works before the legal review
    const res = await call("POST", `/api/documents/${doc.id}/test-send`);
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] /);
    expect(mail.sent[0].text).not.toContain("pat@acme.test");
    const after = (await getDocument(env.DB, doc.id))!;
    expect(after).toMatchObject({ test: true, status: "sent", approvalId: null });
    expect(mail.sent[0].text).toContain(`https://clients.hellositeline.test/p/${after.token}`);
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("recommended");
    expect((await listActivity(env.DB, s.businessId)).filter((x) => x.kind === "proposal_sent")).toEqual([]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'proposal.send' AND json_extract(payload, '$.documentId') = ?`).bind(doc.id).first<{ n: number }>())!.n).toBe(0);
    // The test mail is not a lead email: it neither moves the lead nor writes to its timeline.
    expect((await env.DB.prepare(`SELECT business_id FROM messages WHERE counterpart = ?`).bind(OWNER_EMAIL).first<any>())!.business_id).toBeNull();
    // A document that is no longer a draft cannot be tested again.
    expect((await call("POST", `/api/documents/${doc.id}/test-send`)).status).toBe(409);
    expect(mail.sent).toHaveLength(1);
  });

  it("test-send needs a mailbox that can send, a client base and an owner address", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    await saveSettings(env.DB, { contact_email: "" });
    const noAddress = await call("POST", `/api/documents/${doc.id}/test-send`);
    expect(noAddress.status).toBe(409);
    expect((await noAddress.json<any>()).error).toMatch(/contact email/i);
    await saveSettings(env.DB, { contact_email: OWNER_EMAIL });
    mail = await readyToSend({ mailbox: false });
    const noMailbox = await call("POST", `/api/documents/${doc.id}/test-send`);
    expect(noMailbox.status).toBe(409);
    expect(mail.sent).toEqual([]);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
  });

  it("void requires a reason", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    expect((await call("POST", `/api/documents/${doc.id}/void`, {})).status).toBe(400);
    expect((await call("POST", `/api/documents/${doc.id}/void`, { reason: "   " })).status).toBe(400);
    expect((await call("POST", `/api/documents/${doc.id}/void`, { reason: "x".repeat(301) })).status).toBe(400);
    expect((await getDocument(env.DB, doc.id))!.status).toBe("draft");
    const ok = await call("POST", `/api/documents/${doc.id}/void`, { reason: "  wrong option  " });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "void", voidReason: "wrong option" });
    expect((await listActivity(env.DB, s.businessId)).find((x) => x.kind === "proposal_void")!.detail).toContain("wrong option");
    expect((await call("POST", "/api/documents/nope/void", { reason: "x" })).status).toBe(404);
  });

  it("PUT and void withdraw a waiting approval", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    const status = (id: string) => env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(id).first<{ status: string }>().then((r) => r!.status);
    const first = (await (await call("POST", `/api/documents/${doc.id}/send`)).json<any>()).approvalId;
    expect(await status(first)).toBe("pending");
    expect((await call("PUT", `/api/documents/${doc.id}`, { edits: { scopeNotes: "Edited." } })).status).toBe(200);
    expect(await status(first)).toBe("rejected");
    const second = (await (await call("POST", `/api/documents/${doc.id}/send`)).json<any>()).approvalId;
    expect(second).not.toBe(first);
    expect(await status(second)).toBe("pending");
    expect((await call("POST", `/api/documents/${doc.id}/void`, { reason: "changed my mind" })).status).toBe(200);
    expect(await status(second)).toBe("rejected");
  });

  it("a signed document cannot be voided", async () => {
    const s = await seedProposalDeal();
    const { doc } = await draft(s);
    await env.DB.prepare(`UPDATE documents SET status = 'signed' WHERE id = ?`).bind(doc.id).run();
    expect((await call("POST", `/api/documents/${doc.id}/void`, { reason: "oops" })).status).toBe(409);
  });
});

describe("POST /api/deals/:id/move", () => {
  it("move to proposal_sent is a 409", async () => {
    const s = await seedProposalDeal();
    const res = await call("POST", `/api/deals/${s.dealId}/move`, { to: "proposal_sent" });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toMatch(/proposal/i);
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("recommended");
  });
  it("move to won is a 409", async () => {
    const s = await seedProposalDeal();
    const res = await call("POST", `/api/deals/${s.dealId}/move`, { to: "won" });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toMatch(/payment/i);
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("recommended");
  });
  it("moving to lost and to earlier stages still works", async () => {
    const s = await seedProposalDeal();
    expect((await call("POST", `/api/deals/${s.dealId}/move`, { to: "lost", lostReason: "no budget" })).status).toBe(200);
  });
});
