import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { saveSettings } from "../src/worker/db/settings";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { createDraft, getDocument, signDocument, signaturesFor, voidDocument, type Document } from "../src/worker/db/documents";
import { afterSign, signProposal } from "../src/worker/documents/public";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { ensureSignedPdf, sendSignedCopy, setPdfRendererForTests, signedFileName } from "../src/worker/documents/signed";
import { setMailDeps } from "../src/worker/mail/deps";
import { OWNER_EMAIL, clientSig, proposal, readyToSend, seedDeal, sendDraft } from "./fixtures/documents";

const FAR = "2099-01-01T00:00:00.000Z";
const SIGNED_AT = "2026-12-02T09:00:00.000Z";
const PDF_BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]);
const BROWSER = { marker: "browser" } as unknown as Fetcher;
const E = { ...env, BROWSER } as typeof env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

type PdfFn = NonNullable<NonNullable<Parameters<typeof ensureSignedPdf>[2]>["pdf"]>;
/** A stand-in for the browser: real PDF rendering needs the Browser Rendering binding, which a test run does not have. */
function fakePdf(bytes: Uint8Array = PDF_BYTES) {
  const calls: { html: string; o: unknown }[] = [];
  const pdf: PdfFn = async (_binding, html, o) => { calls.push({ html, o }); return bytes; };
  return { calls, pdf };
}

const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sentDoc(o: { clientName?: string } = {}) {
  const s = await seedDeal();
  const content: ProposalContent = proposal();
  if (o.clientName) content.header = { ...content.header, clientName: o.clientName };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  return { ...s, doc, hash, token: doc.token! };
}
/** A signed proposal, signed the way the page does it but without running the follow-up steps. */
async function signedDoc(o: { clientName?: string } = {}) {
  const s = await sentDoc(o);
  expect(await signDocument(env.DB, s.doc.id, clientSig(s.hash), SIGNED_AT)).toBe("signed");
  const doc = (await getDocument(env.DB, s.doc.id))! satisfies Document;
  return { ...s, doc };
}
/** The timeline notes about a mail that did not go (the log also notes each mail that did). */
const notes = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === "note" && /not sent/.test(a.detail ?? "")).map((a) => a.detail ?? "");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(async () => {
  errors.mockRestore(); setMailDeps(null); setPdfRendererForTests(null);
  await env.DB.prepare(`DELETE FROM do_not_contact`).run(); // storage is shared by the tests of a file
});

describe("ensureSignedPdf", () => {
  it("renders once and stores key and sha256", async () => {
    const s = await signedDoc();
    const f = fakePdf();
    const r = await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf });
    expect(r).toEqual({ ok: true, key: `documents/${s.doc.id}/signed.pdf`, sha256: await sha(PDF_BYTES) });
    const stored = await env.RAW.get(`documents/${s.doc.id}/signed.pdf`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PDF_BYTES);
    expect(stored!.httpMetadata?.contentType).toBe("application/pdf");
    const doc = (await getDocument(env.DB, s.doc.id))!;
    expect(doc).toMatchObject({ pdfKey: `documents/${s.doc.id}/signed.pdf`, pdfSha256: await sha(PDF_BYTES), pdfError: null, status: "signed" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].o).toEqual({ format: "letter" });
  });

  it("a second call does not render again", async () => {
    const s = await signedDoc();
    const f = fakePdf();
    const first = await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf });
    const second = await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf });
    expect(second).toEqual(first);
    expect(f.calls).toHaveLength(1);
    // Even with no browser at all, a document that has its PDF is done.
    expect(await ensureSignedPdf({ ...env, BROWSER: undefined } as typeof env, s.doc.id, { pdf: f.pdf })).toEqual(first);
  });

  it("an unsigned document is refused with 409, and an unknown one is a 404", async () => {
    const s = await sentDoc();
    const f = fakePdf();
    expect(await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf })).toMatchObject({ ok: false, status: 409 });
    await voidDocument(env.DB, s.doc.id, "wrong option");
    expect(await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf })).toMatchObject({ ok: false, status: 409 });
    expect(await ensureSignedPdf(E, "no-such-document", { pdf: f.pdf })).toMatchObject({ ok: false, status: 404 });
    expect(f.calls).toHaveLength(0);
    expect(await env.RAW.get(`documents/${s.doc.id}/signed.pdf`)).toBeNull();
  });

  it("no BROWSER binding is a 501 and records nothing", async () => {
    const s = await signedDoc();
    const f = fakePdf();
    const r = await ensureSignedPdf({ ...env, BROWSER: undefined } as typeof env, s.doc.id, { pdf: f.pdf });
    expect(r).toMatchObject({ ok: false, status: 501 });
    expect(f.calls).toHaveLength(0);
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfKey: null, pdfSha256: null, pdfError: null });
    expect(await env.RAW.get(`documents/${s.doc.id}/signed.pdf`)).toBeNull();
  });

  it("a render failure records pdfError and the signature remains; a retry then succeeds and clears it", async () => {
    const s = await signedDoc();
    const r = await ensureSignedPdf(E, s.doc.id, { pdf: async () => { throw new Error("browser crashed\nwith a second line"); } });
    expect(r).toMatchObject({ ok: false, status: 502 });
    const failed = (await getDocument(env.DB, s.doc.id))!;
    expect(failed.status).toBe("signed");
    expect(failed.pdfKey).toBeNull();
    expect(failed.pdfError).toBe("browser crashed with a second line");
    expect((await signaturesFor(env.DB, s.doc.id)).filter((x) => x.role === "client")).toHaveLength(1);
    expect(await env.RAW.get(`documents/${s.doc.id}/signed.pdf`)).toBeNull();

    const f = fakePdf();
    expect(await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf })).toMatchObject({ ok: true });
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfError: null, pdfSha256: await sha(PDF_BYTES) });
  });

  it("an empty render is a failure, not a stored empty file", async () => {
    const s = await signedDoc();
    expect(await ensureSignedPdf(E, s.doc.id, { pdf: async () => new Uint8Array() })).toMatchObject({ ok: false, status: 502 });
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfKey: null });
    expect(await env.RAW.get(`documents/${s.doc.id}/signed.pdf`)).toBeNull();
  });

  it("a file already stored by an attempt that died before recording it is adopted, never overwritten", async () => {
    const s = await signedDoc();
    const earlier = new Uint8Array([37, 80, 68, 70, 9, 9, 9]);
    await env.RAW.put(`documents/${s.doc.id}/signed.pdf`, earlier);
    const f = fakePdf();
    const r = await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf });
    expect(r).toEqual({ ok: true, key: `documents/${s.doc.id}/signed.pdf`, sha256: await sha(earlier) });
    expect(new Uint8Array(await (await env.RAW.get(`documents/${s.doc.id}/signed.pdf`))!.arrayBuffer())).toEqual(earlier);
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfSha256: await sha(earlier) });
  });

  it("the html handed to the renderer has the audit page and both signatures, from the frozen content and its stored hash", async () => {
    const s = await signedDoc({ clientName: "Ace <b>Plumbing</b>" });
    const f = fakePdf();
    await ensureSignedPdf(E, s.doc.id, { pdf: f.pdf });
    const html = f.calls[0].html;
    expect(html).toContain("Audit page");
    expect(html).toContain("Signed electronically under the US ESIGN Act.");
    expect(html).toContain("Pat Jones"); // the client's signature
    expect(html).toContain("Pat Provider"); // the provider's
    expect(html).toContain("203.0.113.9");
    expect(html).toContain("I agree to sign electronically."); // the consent as stored with the signature
    expect(html.split(s.hash).length - 1).toBeGreaterThanOrEqual(2); // the stored fingerprint, on the signature block and the audit page
    expect(html).toContain('class="pdf"');
    expect(html).not.toContain("DRAFT");
    expect(html).not.toContain("Ace <b>"); // escaped
    expect(html).not.toContain("<script");
  });
});

describe("sendSignedCopy", () => {
  it("mails the signer from main with the client link and notifies the owner", async () => {
    const mail = await readyToSend();
    const s = await signedDoc();
    await sendSignedCopy(E, s.doc);
    expect(mail.sent).toHaveLength(2);
    const [toSigner, toOwner] = mail.sent;
    expect(toSigner.to).toBe("pat@ace.test");
    expect(toSigner.from.email).toBe("logan@main.test");
    expect(toSigner.subject).toBe("Your signed proposal from Siteline");
    expect(toSigner.text).toContain(`https://clients.hellositeline.test/p/${s.token}`);
    expect(toSigner.text).toContain("Ace Plumbing");
    expect(toOwner.to).toBe(OWNER_EMAIL);
    expect(toOwner.from.email).toBe("logan@main.test");
    expect(toOwner.subject).toBe("Ace Plumbing signed SL-ABCDEF");
    expect(toOwner.text).not.toContain("Pat Jones"); // nothing a prospect typed beyond the business name
    expect(await notes(s.businessId)).toEqual([]);
  });

  it("puts nothing a prospect typed on more than one line of a header or a body line, and says nothing of the signer's own words", async () => {
    const mail = await readyToSend();
    const s = await signedDoc({ clientName: "Ace\r\nBcc: spy@evil.test\r\nPlumbing" });
    await sendSignedCopy(E, s.doc);
    for (const m of mail.sent) {
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.text).not.toMatch(/\r|Bcc: spy@evil.test\n/);
    }
    expect(mail.sent[0].text).toContain("Ace Bcc: spy@evil.test Plumbing");
    expect(mail.sent[0].text).not.toContain("Pat Jones");
  });

  it("without a link base it says to reply instead of inventing an address", async () => {
    const mail = await readyToSend();
    const s = await signedDoc();
    await sendSignedCopy({ ...env, CLIENT_LINK_BASE: undefined } as typeof env, s.doc);
    expect(mail.sent[0].text).not.toContain("/p/");
    expect(mail.sent[0].text).toMatch(/[Rr]eply to this email/);
  });

  it("a blank owner address means no notice, not a failure", async () => {
    const mail = await readyToSend();
    await saveSettings(env.DB, { contact_email: "  " });
    const s = await signedDoc();
    await sendSignedCopy(E, s.doc);
    expect(mail.sent.map((m) => m.to)).toEqual(["pat@ace.test"]);
    expect(await notes(s.businessId)).toEqual([]);
  });

  it("swallows a do-not-contact address and logs a note, and still tells the owner", async () => {
    const mail = await readyToSend();
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const s = await signedDoc();
    await expect(sendSignedCopy(E, s.doc)).resolves.toBeUndefined();
    expect(mail.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    const logged = await notes(s.businessId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^signed copy not sent: .*do-not-contact/);
    expect(errors).toHaveBeenCalled();
    expect((await getDocument(env.DB, s.doc.id))!.status).toBe("signed");
  });

  it("swallows a missing mailbox and an SMTP error, each as a note, and never throws", async () => {
    const mail = await readyToSend({ mailbox: false });
    const a = await signedDoc();
    await expect(sendSignedCopy(E, a.doc)).resolves.toBeUndefined();
    expect(mail.sent).toHaveLength(0);
    expect((await notes(a.businessId)).join("\n")).toMatch(/signed copy not sent: .*not enabled/);

    const mail2 = await readyToSend();
    mail2.failures.push(new Error("550 mailbox unavailable"));
    const b = await signedDoc();
    await expect(sendSignedCopy(E, b.doc)).resolves.toBeUndefined();
    expect(mail2.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect((await notes(b.businessId))[0]).toMatch(/^signed copy not sent: .*550 mailbox unavailable/);
  });

  it("runs the conflict gate on the signer before the lead is won: a lead already won is not mailed", async () => {
    const mail = await readyToSend();
    const s = await signedDoc();
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(s.businessId).run();
    await sendSignedCopy(E, s.doc);
    expect(mail.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect((await notes(s.businessId))[0]).toMatch(/existing client/);
  });
});

describe("the file name", () => {
  it("keeps letters of any script in filename* and folds the ascii one", () => {
    const now = new Date("2026-12-02T09:00:00Z");
    expect(signedFileName("Łódź  Plumbing", now)).toBe("Łódź Plumbing - Proposal - 2026-12-02.pdf");
    expect(signedFileName("Łódź  Plumbing", now, { ascii: true })).toBe("Lodz Plumbing - Proposal - 2026-12-02.pdf");
    expect(signedFileName("東京配管", now)).toBe("東京配管 - Proposal - 2026-12-02.pdf");
    expect(signedFileName("東京配管", now, { ascii: true })).toBe("Website - Proposal - 2026-12-02.pdf");
    expect(signedFileName("Ace / Plumbing\r\n\"Co\"", now)).toBe("Ace Plumbing Co - Proposal - 2026-12-02.pdf");
  });
});

describe("the public pdf route", () => {
  const get = (path: string, e: Partial<typeof env> = { BROWSER }, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://x/api/public${path}`, init), { ...env, ...e } as typeof env, ctx);

  it("is a 404 before signing, in every state that is not signed, and streams after", async () => {
    const f = fakePdf();
    setPdfRendererForTests(f.pdf);
    const open = await sentDoc();
    const voided = await sentDoc();
    await voidDocument(env.DB, voided.doc.id, "x");
    const draftS = await seedDeal();
    const draft = await createDraft(env.DB, { dealId: draftS.dealId, businessId: draftS.businessId, optionId: "b", content: proposal() });
    await env.DB.prepare(`UPDATE documents SET token = ? WHERE id = ?`).bind("D".repeat(43), draft.id).run();
    for (const token of [open.token, voided.token!, "D".repeat(43), "A".repeat(43), "short"]) {
      const r = await get(`/p/${token}/pdf`);
      expect(r.status, token).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(f.calls).toHaveLength(0);

    expect(await signDocument(env.DB, open.doc.id, clientSig(open.hash), SIGNED_AT)).toBe("signed");
    const ok = await get(`/p/${open.token}/pdf`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-disposition")).toBe(
      `attachment; filename="Ace Plumbing - Proposal - 2026-12-02.pdf"; filename*=UTF-8''Ace%20Plumbing%20-%20Proposal%20-%202026-12-02.pdf`);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PDF_BYTES);
    // Made on the first request (nothing had made it), and not again on the next.
    expect(f.calls).toHaveLength(1);
    expect((await get(`/p/${open.token}/pdf`)).status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("without the Browser Rendering binding a signed document with no PDF yet is a 501, and one that has it still streams", async () => {
    const s = await signedDoc();
    const r = await get(`/p/${s.token}/pdf`, { BROWSER: undefined });
    expect(r.status).toBe(501);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfKey: null, pdfError: null });
    await ensureSignedPdf(E, s.doc.id, { pdf: fakePdf().pdf });
    expect((await get(`/p/${s.token}/pdf`, { BROWSER: undefined })).status).toBe(200);
  });

  it("a failed render is a 502 that says nothing of why, and the signature stands", async () => {
    setPdfRendererForTests(async () => { throw new Error("secret internal detail"); });
    const s = await signedDoc();
    const r = await get(`/p/${s.token}/pdf`);
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("secret internal detail");
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ status: "signed", pdfKey: null, pdfError: "secret internal detail" });
  });

  it("needs no cookie, but only GET on exactly this path: every neighbour stays protected", async () => {
    const s = await signedDoc();
    await ensureSignedPdf(E, s.doc.id, { pdf: fakePdf().pdf });
    expect((await get(`/p/${s.token}/pdf`)).status).toBe(200);
    for (const [path, method] of [
      [`/p/${s.token}/pdf`, "POST"], [`/p/${s.token}/pdf`, "PUT"], [`/p/${s.token}/pdf`, "DELETE"], [`/p/${s.token}/pdf/`, "GET"], [`/p/${s.token}/pdf/x`, "GET"],
      [`/p/${s.token}/pdf.pdf`, "GET"], [`/p/${s.token}/PDF`, "GET"], ["/p//pdf", "GET"], [`/p/${s.token}/x/pdf`, "GET"], [`/p/${s.token}/pdfx`, "GET"], ["/pdf", "GET"],
    ] as const) {
      const r = await get(path, { BROWSER }, { method, body: method === "GET" ? undefined : "{}" });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it("the limiter applies to it", async () => {
    const s = await signedDoc();
    const keys: string[] = [];
    const CLIENT_LIMITER = { limit: async (o: { key: string }) => { keys.push(o.key); return { success: false }; } } as unknown as RateLimit;
    const r = await get(`/p/${s.token}/pdf`, { BROWSER, CLIENT_LIMITER }, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(r.status).toBe(429);
    expect(keys).toEqual([`${s.token}:203.0.113.9`]);
  });
});

describe("the owner's pdf route", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const owner = (id: string, auth = true) => SELF.fetch(`https://x/api/documents/${id}/pdf`, { headers: auth ? { cookie } : {} });

  it("requires sign-in, and streams the signed copy", async () => {
    const s = await signedDoc();
    await ensureSignedPdf(E, s.doc.id, { pdf: fakePdf().pdf });
    expect((await owner(s.doc.id, false)).status).toBe(401);
    const r = await owner(s.doc.id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toContain(`filename="Ace Plumbing - Proposal - 2026-12-02.pdf"`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it("an unknown document is a 404 and one that is not signed is a 409", async () => {
    expect((await owner("no-such-document")).status).toBe(404);
    const s = await sentDoc();
    expect((await owner(s.doc.id)).status).toBe(409);
  });
});

describe("afterSign", () => {
  it("makes the pdf, then mails the copy, as ordered guarded steps", async () => {
    const mail = await readyToSend();
    const f = fakePdf();
    setPdfRendererForTests(f.pdf);
    const s = await signedDoc();
    await afterSign(E, s.doc);
    expect(await getDocument(env.DB, s.doc.id)).toMatchObject({ pdfKey: `documents/${s.doc.id}/signed.pdf`, pdfSha256: await sha(PDF_BYTES) });
    expect(mail.sent.map((m) => m.to)).toEqual(["pat@ace.test", OWNER_EMAIL]);
  });

  it("a failed pdf never stops the mail, and a failed mail never undoes the pdf; nothing throws out of it", async () => {
    const mail = await readyToSend();
    setPdfRendererForTests(async () => { throw new Error("no browser today"); });
    const a = await signedDoc();
    await expect(afterSign(E, a.doc)).resolves.toBeUndefined();
    expect(mail.sent.map((m) => m.to)).toEqual(["pat@ace.test", OWNER_EMAIL]);
    expect(await getDocument(env.DB, a.doc.id)).toMatchObject({ pdfKey: null, pdfError: "no browser today" });

    const f = fakePdf();
    setPdfRendererForTests(f.pdf);
    const b = await signedDoc();
    mail.failures.push(new Error("smtp down"), new Error("smtp still down"));
    await expect(afterSign(E, b.doc)).resolves.toBeUndefined();
    expect(await getDocument(env.DB, b.doc.id)).toMatchObject({ pdfKey: `documents/${b.doc.id}/signed.pdf` });
    expect((await notes(b.businessId)).length).toBeGreaterThan(0);
  });

  it("a sign through the page runs it once; the idempotent second sign does not re-run it", async () => {
    const mail = await readyToSend();
    const f = fakePdf();
    setPdfRendererForTests(f.pdf);
    const s = await sentDoc();
    const form = { name: "Pat Jones", consent: true, authority: true, sha256: s.hash };
    const o = { now: new Date("2026-12-02T09:00:00.000Z"), ip: "203.0.113.9", userAgent: "TestBrowser/1.0" };
    expect((await signProposal(E, s.token, form, o)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(mail.sent).toHaveLength(2);
    expect((await signProposal(E, s.token, form, o)).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(mail.sent).toHaveLength(2);
  });
});
