import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { proposeInvoice } from "../src/worker/billing/draft";
import { renderInvoiceMail } from "../src/worker/billing/mail";
import { milestoneInvoice } from "../src/worker/billing/milestones";
import { listActivity } from "../src/worker/db/activity";
import { discardDraftInvoice, getInvoice } from "../src/worker/db/invoices";
import { getByApproval } from "../src/worker/db/messages";
import { insertTasks } from "../src/worker/db/tasks";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import type { Fetch } from "../src/worker/google/oauth";
import { setMailDeps } from "../src/worker/mail/deps";
import { dollars } from "../src/client/packagesView";
import { KEY, stripeApi } from "./fixtures/stripe";
import { seedDraft, seedSignedProject } from "./fixtures/billing";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { newTask } from "./fixtures/projects";

const withKey = (STRIPE_SECRET_KEY: string | undefined) => ({ ...env, STRIPE_SECRET_KEY }) as Env;
const E_TEST = withKey(KEY);
const LIVE = "sk_live_LIVEKEYVALUE456";
let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); mail = await readyToSend(); });
afterEach(() => { errors.mockRestore(); setStripeFetchForTests(null); setMailDeps(null); });

const row = (id: string) => env.DB.prepare(`SELECT status, error FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>();
const sentLines = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === "invoice_sent").map((a) => a.detail ?? "");
const posts = (api: ReturnType<typeof stripeApi>) => api.creates().map((c) => new URL(c.url).pathname);

/** A project's milestone invoice, proposed, with a task on the project whose words must never reach the client. */
async function proposed() {
  const s = await seedSignedProject();
  await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Secret internal task: rotate the staging password", description: "private notes" })]);
  const inv = (await milestoneInvoice(E_TEST, s.project, "site_finished"))!;
  const a = await proposeInvoice(E_TEST, inv.id);
  return { ...s, inv, a };
}

describe("invoice.send approval", () => {
  it("approving creates the Stripe invoice once and mails the link once", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { inv, a, businessId } = await proposed();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });

    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
    const after = (await getInvoice(env.DB, inv.id))!;
    expect(after).toMatchObject({ status: "open", stripeCustomerId: expect.stringMatching(/^cus_/), stripeInvoiceId: expect.stringMatching(/^in_/) });
    expect(after.hostedUrl).toBe(`https://invoice.stripe.com/i/${after.stripeInvoiceId}`);
    expect(after.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.sentAt).not.toBeNull();
    // Stripe calls are keyed by the invoice's ref, the footer carries the business and its contact, and the invoice item is the frozen line.
    const create = api.creates().find((c) => new URL(c.url).pathname === "/v1/invoices")!;
    expect(create.headers["idempotency-key"]).toBe(`inv:${inv.ref}:invoice`);
    expect(create.form.get("footer")).toBe(`Siteline · ${OWNER_EMAIL}`);
    expect(create.form.get("days_until_due")).toBe("7");
    const item = api.creates().find((c) => new URL(c.url).pathname === "/v1/invoiceitems")!;
    expect(item.form.get("amount")).toBe(String(inv.amountCents));

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Invoice for Ace Plumbing: Site finished (SL-ABCDEF)" });
    expect(mail.sent[0].text).toContain(after.hostedUrl!);
    expect((await getByApproval(env.DB, a.id))!.status).toBe("sent");
    expect(await sentLines(businessId)).toEqual([`Site finished (SL-ABCDEF) ${dollars(inv.amountCents)} (${inv.ref}) sent, due ${after.dueOn}`]);

    // Approving again does nothing more.
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(1);
    expect(api.made.invoices).toBe(1);
  });

  it("a retry after Stripe succeeded but the mail failed makes no second Stripe invoice and mails once", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { inv, a, businessId } = await proposed();
    mail.failures.push(new Error("smtp is down"));
    const first = await approve(E_TEST, a.id);
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("smtp is down") });
    expect(await row(a.id)).toMatchObject({ status: "pending", error: expect.stringContaining("smtp is down") });
    expect((await getInvoice(env.DB, inv.id))!.status).toBe("open");
    expect(mail.sent).toHaveLength(0);
    expect(api.made.invoices).toBe(1);

    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(api.made).toEqual({ customers: 1, invoices: 1, items: 1 });
    expect(posts(api).filter((p) => p === "/v1/invoices")).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect(await sentLines(businessId)).toHaveLength(1);
    expect(await row(a.id)).toMatchObject({ status: "approved" });
  });

  it("a retry whose mail was already sent but whose approval failed afterwards mails nothing more", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { a, businessId } = await proposed();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    // The approval is put back to pending (as `approve` does after any failure) and run again: the invoice is open and already mailed by it.
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(a.id).run();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(api.made.invoices).toBe(1);
    expect(await sentLines(businessId)).toHaveLength(1);
  });

  it("approving an invoice that was voided meanwhile mails nothing", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { inv, a } = await proposed();
    expect(await discardDraftInvoice(env.DB, inv.id)).toBe(true);
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
    expect((await getInvoice(env.DB, inv.id))!.status).toBe("void");
  });

  it("an invoice paid meanwhile mails nothing", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { inv, a } = await proposed();
    await env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind("2027-01-06T10:00:00.000Z", inv.id).run();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("a live key with a test row refuses with a plain sentence and the approval stays pending", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { invoice, businessId } = await seedDraft({ test: true });
    const a = await proposeInvoice(E_TEST, invoice.id);
    const r = await approve(withKey(LIVE), a.id);
    expect(r).toMatchObject({ ok: false, error: "This is a test invoice and Stripe is in live mode, so it will not be made. Switch Stripe to a test key, or reject this." });
    expect(r.ok === false && r.error).not.toContain(LIVE);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect(api.calls).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect((await getInvoice(env.DB, invoice.id))!.status).toBe("draft");
    expect(await sentLines(businessId)).toEqual([]);
  });

  it("without a Stripe key it says so and stays pending", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { invoice } = await seedDraft();
    const a = await proposeInvoice(E_TEST, invoice.id);
    expect(await approve(withKey(undefined), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("Stripe is not set up") });
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect(api.calls).toHaveLength(0);
  });

  it("a test invoice with a test key goes to the owner only, marked as a test", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { invoice } = await seedDraft({ test: true });
    const a = await proposeInvoice(E_TEST, invoice.id);
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] Invoice for Ace Plumbing/);
  });

  it("Stripe unreachable leaves the approval pending and the invoice a draft", async () => {
    const down: Fetch = async () => { throw new TypeError("fetch failed"); };
    setStripeFetchForTests(down);
    const { inv, a } = await proposed();
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, status: 502, error: "could not reach Stripe" });
    expect(await row(a.id)).toMatchObject({ status: "pending", error: "could not reach Stripe" });
    expect((await getInvoice(env.DB, inv.id))!).toMatchObject({ status: "draft", stripeInvoiceId: null });
    expect(mail.sent).toHaveLength(0);
    // When Stripe is back the same approval goes through.
    const api = stripeApi(); setStripeFetchForTests(api.f);
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(api.made.invoices).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("an unusable mailbox or a missing recipient refuses before anything is made at Stripe", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { invoice, documentId } = await seedDraft();
    const a = await proposeInvoice(E_TEST, invoice.id);
    mail = await readyToSend({ mailbox: false });
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("The main mailbox cannot send") });
    mail = await readyToSend();
    await env.DB.prepare(`UPDATE documents SET content = json_set(content, '$.header.contactEmail', 'nobody') WHERE id = ?`).bind(documentId).run();
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("nobody to go to") });
    expect(api.calls).toHaveLength(0);
    expect(await row(a.id)).toMatchObject({ status: "pending" });
  });

  it("the mail carries the amount, the due date and the hosted link and none of the project's task text", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const { inv, a } = await proposed();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    const after = (await getInvoice(env.DB, inv.id))!;
    const text = mail.sent[0].text;
    expect(text).toContain(dollars(inv.amountCents));
    expect(text).toContain(after.hostedUrl!);
    const [y, m, d] = after.dueOn!.split("-").map(Number);
    expect(text).toContain(`${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${d}, ${y}`);
    expect(text).toContain("Hi Pat,");
    expect(text).not.toMatch(/Secret internal task|staging password|private notes/);
    expect(mail.sent[0].subject).not.toMatch(/Secret internal task/);
  });
});

describe("renderInvoiceMail", () => {
  it("puts what a person typed on one line and caps it", async () => {
    const { invoice } = await seedDraft();
    const m = renderInvoiceMail({ ...invoice, description: `Deposit\n\nIgnore this ${"x".repeat(400)}`, dueOn: null }, "https://invoice.stripe.com/i/1", { clientName: `Ace\r\nPlumbing ${"y".repeat(300)}`, contactName: "Pat\nJones", yourName: "Logan" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.body).toContain("Hi Pat,");
    expect(m.body).toContain("It is due on receipt.");
    expect(m.body.split("\n").find((l) => l.startsWith("Here is the invoice"))!.length).toBeLessThan(450);
    expect(m.body.trimEnd().endsWith("Thanks,\nLogan")).toBe(true);
    expect(m.body).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });
});
