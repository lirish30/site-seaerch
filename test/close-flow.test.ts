import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal, moveDeal } from "../src/worker/db/deals";
import { getDocument, signaturesFor } from "../src/worker/db/documents";
import { getInvoiceForDocument } from "../src/worker/db/invoices";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { canonicalJson, sha256Hex } from "../src/worker/documents/hash";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { setMailDeps } from "../src/worker/mail/deps";
import { readyToSend, stubPdfRenderer } from "./fixtures/documents";
import { invoiceEvent } from "./fixtures/stripe";
import { deliver, signedDeal } from "./fixtures/close";

// The whole close, through the entry points the app really uses, with the world replaced by fakes: Stripe, the mail transport and the PDF browser.
let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  stubPdfRenderer();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); setPdfRendererForTests(null); setStripeFetchForTests(null); });

const kinds = async (businessId: string) => (await listActivity(env.DB, businessId, 200)).map((a) => a.kind);

describe("the close, end to end", () => {
  it("a recommended deal goes from draft to won", async () => {
    const s = await signedDeal();

    // Signed: two signatures on one hash, which is the hash of the content as stored.
    const doc = (await getDocument(env.DB, s.docId))!;
    expect(doc.status).toBe("signed");
    expect(doc.contentSha256).toBe(await sha256Hex(canonicalJson(doc.content)));
    const sigs = await signaturesFor(env.DB, s.docId);
    expect(sigs.map((x) => x.role).sort()).toEqual(["client", "provider"]);
    expect(new Set(sigs.map((x) => x.contentSha256))).toEqual(new Set([doc.contentSha256]));
    expect(sigs.find((x) => x.role === "client")).toMatchObject({ signerName: "Pat Jones", signerEmail: "pat@acme.test" });

    // The signed PDF is in R2 and its hash is recorded.
    expect(doc.pdfKey).toBeTruthy();
    const stored = await env.RAW.get(doc.pdfKey!);
    expect(stored).not.toBeNull();
    expect(doc.pdfSha256).toBe(await sha256Hex(new Uint8Array(await stored!.arrayBuffer())));

    // The mail: the proposal link first, then the signed copy to the client (and the notice to the owner).
    const link = `https://clients.hellositeline.test/p/${doc.token}`;
    const toClient = mail.sent.filter((m) => m.to === "pat@acme.test");
    expect(toClient).toHaveLength(2);
    expect(toClient[0].text).toContain(link);
    expect(toClient[1].subject).toMatch(/signed/i);
    expect(mail.sent.filter((m) => m.to === "logan@siteline.test")).toHaveLength(1);

    // The deposit invoice exists at the fake Stripe and is open; nothing is won yet.
    const invoice = (await getInvoiceForDocument(env.DB, s.docId))!;
    expect(invoice).toMatchObject({ kind: "deposit", status: "open", amountCents: doc.content.schedule.depositCents, dealId: s.dealId });
    expect(s.api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("proposal_sent");

    // The payment arrives by webhook.
    expect(await deliver(invoiceEvent("invoice.paid", invoice))).toBe(200);

    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("won");
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).toBe("won");
    expect(await getInvoiceForDocument(env.DB, s.docId)).toMatchObject({ status: "paid", mismatch: null });
    expect((await getDocument(env.DB, s.docId))!.paidAt).toBeTruthy();
    expect(await kinds(s.businessId)).toEqual(expect.arrayContaining(["proposal_sent", "proposal_signed", "deposit_paid"]));
  });

  it("a deal marked lost after sending is not reopened by a late payment", async () => {
    const s = await signedDeal();
    await moveDeal(env.DB, s.dealId, "lost", { lostReason: "went with a cousin" });
    const invoice = (await getInvoiceForDocument(env.DB, s.docId))!;

    expect(await deliver(invoiceEvent("invoice.paid", invoice))).toBe(200);

    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("lost");
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).not.toBe("won");
    const notes = (await listActivity(env.DB, s.businessId, 200)).filter((a) => a.kind === "note").map((a) => a.detail);
    expect(notes).toContain("deposit paid but the deal is lost: check it");
    expect((await getDocument(env.DB, s.docId))!.paidAt).toBeTruthy();
    expect(await getInvoiceForDocument(env.DB, s.docId)).toMatchObject({ status: "paid" });
  });

  it("the same webhook event delivered again changes nothing", async () => {
    const s = await signedDeal();
    const invoice = (await getInvoiceForDocument(env.DB, s.docId))!;
    const event = invoiceEvent("invoice.paid", invoice);
    expect(await deliver(event)).toBe(200);
    const doc = (await getDocument(env.DB, s.docId))!;
    const before = { activity: (await listActivity(env.DB, s.businessId, 200)).length, paidAt: doc.paidAt, mail: mail.sent.length };

    expect(await deliver(event)).toBe(200);

    expect((await listActivity(env.DB, s.businessId, 200)).length).toBe(before.activity);
    expect((await getDocument(env.DB, s.docId))!.paidAt).toBe(before.paidAt);
    expect(mail.sent.length).toBe(before.mail);
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("won");
  });
});
