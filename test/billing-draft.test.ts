import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reject } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { draftAndPropose, proposeInvoice } from "../src/worker/billing/draft";
import { milestoneHook, milestoneInvoice, reconcileMilestones } from "../src/worker/billing/milestones";
import { discardDraftInvoice, getInvoice, listInvoices } from "../src/worker/db/invoices";
import { reachMilestone } from "../src/worker/db/projects";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { clearProjectHooksForTests, onMilestone, runMilestone } from "../src/worker/projects/hooks";
import { seedDraft, seedSignedProject } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";

const e = env as Env;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); setMailDeps(null); });

const waiting = async (invoiceId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'invoice.send' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoiceId).all<{ id: string }>()).results;

describe("proposing an invoice", () => {
  it("the kind is registered and takes only an invoice id", () => {
    const h = getHandler("invoice.send")!;
    expect(h.label).toBe("Send invoice");
    expect(h.parse({ invoiceId: "x" })).toEqual({ invoiceId: "x" });
    expect(() => h.parse({})).toThrow();
  });

  it("proposeInvoice twice returns one approval", async () => {
    const { invoice, businessId } = await seedDraft({ lines: [{ description: "Design approved (SL-ABCDEF)", amountCents: 123450 }] });
    const a = await proposeInvoice(e, invoice.id);
    expect(a).toMatchObject({ kind: "invoice.send", status: "pending", payload: { invoiceId: invoice.id }, record_type: "business", record_id: businessId, drafted_by: "logan" });
    const b = await proposeInvoice(e, invoice.id);
    expect(b.id).toBe(a.id);
    expect(await waiting(invoice.id)).toHaveLength(1);
    // The preview is the mail the client will get and the money, and says nothing is made until approval.
    expect(a.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a.preview).toContain("Subject: Invoice for Ace Plumbing: Milestone");
    expect(a.preview).toContain("Hi Pat,");
    expect(a.preview).toContain("Total: $1,234.50");
    expect(a.preview).toContain("  - Design approved (SL-ABCDEF): $1,234.50");
    expect(a.preview).toMatch(/Due: \d{4}-\d{2}-\d{2} \(7 days after it is sent\)/);
    expect(a.preview).toContain("(the link is made when you approve)");
    expect(a.preview).toContain("Nothing is made at Stripe, and nothing is mailed, until you approve.");
  });

  it("a project's invoice is filed under the project", async () => {
    const s = await seedSignedProject();
    const inv = (await milestoneInvoice(e, s.project, "site_finished"))!;
    const a = await proposeInvoice(e, inv.id);
    expect(a).toMatchObject({ record_type: "project", record_id: s.project.id });
    expect(a.title).toBe("Send invoice Site finished (SL-ABCDEF) to Ace Plumbing");
  });

  it("refuses an invoice that is not a draft, or that does not exist, with a plain sentence", async () => {
    const { invoice } = await seedDraft();
    expect(await discardDraftInvoice(env.DB, invoice.id)).toBe(true);
    await expect(proposeInvoice(e, invoice.id)).rejects.toThrow("This invoice is void, not a draft.");
    await expect(proposeInvoice(e, "no-such-invoice")).rejects.toThrow("There is no such invoice.");
  });

  it("a test invoice's preview says where the mail really goes", async () => {
    const { invoice } = await seedDraft({ test: true });
    const a = await proposeInvoice(e, invoice.id);
    expect(a.preview).toContain("To: Logan Irish <logan@siteline.test> (a test: nothing goes to pat@ace.test)");
    expect(a.preview).toContain("Subject: [Test] Invoice for Ace Plumbing");
  });

  it("an invoice with nobody to go to is still proposed, and the preview says so", async () => {
    const { invoice, documentId } = await seedDraft();
    await env.DB.prepare(`UPDATE documents SET content = json_set(content, '$.header.contactEmail', 'not an address') WHERE id = ?`).bind(documentId).run();
    const a = await proposeInvoice(e, invoice.id);
    expect(a.preview).toContain("To: nobody yet (");
  });

  it("draftAndPropose makes one draft and one approval, and none once the invoice is no longer a draft", async () => {
    const s = await seedDraft();
    const o = { businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, changeOrderId: null, subscriptionId: null, kind: "milestone" as const, ref: "milestone:draft-test:1", test: false, description: "Milestone", lines: [{ description: "Milestone", amountCents: 5000 }] };
    const first = await draftAndPropose(e, o);
    const second = await draftAndPropose(e, o);
    expect(first.invoice.id).toBe(second.invoice.id);
    expect(first.approval!.id).toBe(second.approval!.id);
    expect([first.created, second.created]).toEqual([true, false]); // only the call that made the draft says so
    expect(await waiting(first.invoice.id)).toHaveLength(1);
    await discardDraftInvoice(env.DB, first.invoice.id);
    expect(await draftAndPropose(e, o)).toMatchObject({ invoice: { id: first.invoice.id, status: "void" }, approval: null });
  });

  it("a draft whose approval is rejected stays a draft and reconcile does not draft it again", async () => {
    const s = await seedSignedProject();
    onMilestone(milestoneHook);
    await runMilestone(e, s.project, "site_finished");
    await reachMilestone(env.DB, s.project.id, "site_finished", "2027-01-05T10:00:00.000Z");
    const [inv] = (await listInvoices(env.DB, { projectId: s.project.id }));
    const [a] = await waiting(inv.id);
    expect(await reject(env.DB, a.id, "not yet")).toBe(true);
    expect((await getInvoice(env.DB, inv.id))!.status).toBe("draft");
    expect(await reconcileMilestones(e)).toBe(0);
    expect(await listInvoices(env.DB, { projectId: s.project.id })).toHaveLength(1);
    expect(await waiting(inv.id)).toHaveLength(0);
    // Logan can ask for a fresh approval of the same draft.
    expect((await proposeInvoice(e, inv.id)).id).not.toBe(a.id);
  });
});
