import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardInvoice, voidSentInvoice } from "../src/worker/billing/discard";
import { hourlyInvoice } from "../src/worker/billing/hourly";
import { proposeInvoice } from "../src/worker/billing/draft";
import { milestoneInvoice } from "../src/worker/billing/milestones";
import { isOnHold, placeHold } from "../src/worker/db/holds";
import { getInvoice, markInvoice } from "../src/worker/db/invoices";
import { insertTasks } from "../src/worker/db/tasks";
import { insertEntry, listEntriesForTask } from "../src/worker/db/time";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { openInvoice, seedSignedProject } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";
import { newTask } from "./fixtures/projects";
import { KEY, stripeApi, stripeError } from "./fixtures/stripe";

const E = { ...env, STRIPE_SECRET_KEY: KEY } as Env;
const NOW = new Date("2026-12-10T12:00:00.000Z");
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); await env.DB.prepare(`DELETE FROM time_entries`).run(); });
afterEach(() => { errors.mockRestore(); setStripeFetchForTests(null); setMailDeps(null); });

const approvalStatus = async (id: string) => (await env.DB.prepare(`SELECT status, decision_note FROM approvals WHERE id = ?`).bind(id).first<{ status: string; decision_note: string | null }>())!;

/** A signed project with 40 billable minutes logged, billed on a hourly draft that is waiting for approval. */
async function hourlyDraft() {
  const s = await seedSignedProject();
  const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId)]);
  await insertEntry(env.DB, { taskId: task.id, projectId: s.project.id, businessId: s.businessId, startedAt: "2026-12-03T17:00:00.000Z", endedAt: "2026-12-03T17:40:00.000Z", minutes: 40, billable: true, note: "", source: "manual" });
  const made = (await hourlyInvoice(E, { projectId: s.project.id, now: NOW }))!;
  return { ...s, task, ...made };
}

describe("discarding and voiding invoices", () => {
  it("discarding a draft releases its time entries and rejects its approval", async () => {
    const h = await hourlyDraft();
    expect((await listEntriesForTask(env.DB, h.task.id))[0].invoicedRef).toBe(h.invoice.ref);
    const out = await discardInvoice(E, h.invoice.id);
    expect(out).toMatchObject({ id: h.invoice.id, status: "void", stripeInvoiceId: null });
    expect((await getInvoice(env.DB, h.invoice.id))!.status).toBe("void");
    expect(await approvalStatus(h.approval!.id)).toMatchObject({ status: "rejected", decision_note: "the invoice was discarded" });
    expect((await listEntriesForTask(env.DB, h.task.id))[0].invoicedRef).toBeNull();
    // Repeating it changes nothing, and the freed time can be billed on a new draft.
    expect((await discardInvoice(E, h.invoice.id)).status).toBe("void");
    const next = (await hourlyInvoice(E, { projectId: h.project.id, now: NOW }))!;
    expect(next.invoice.ref).toBe(`hourly:${h.project.id}:2`);
    // A milestone draft is discarded the same way (no time to release).
    const m = (await milestoneInvoice(E, h.project, "site_finished"))!;
    const ma = await proposeInvoice(E, m.id);
    expect((await discardInvoice(E, m.id)).status).toBe("void");
    expect((await approvalStatus(ma.id)).status).toBe("rejected");
  });

  it("voiding an open invoice calls Stripe once and lifts its hold", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const h = await hourlyDraft();
    const open = await openInvoice(h.invoice);
    expect(await placeHold(env.DB, { businessId: h.businessId, invoiceId: open.id, now: "2026-12-12T00:00:00.000Z" })).toBe(true);
    expect(await isOnHold(env.DB, h.businessId)).toBe(true);

    const out = await voidSentInvoice(E, open.id);
    expect(out.status).toBe("void");
    const voids = api.creates().filter((c) => new URL(c.url).pathname.endsWith("/void"));
    expect(voids).toHaveLength(1);
    expect(new URL(voids[0].url).pathname).toBe(`/v1/invoices/${open.stripeInvoiceId}/void`);
    expect(voids[0].headers["idempotency-key"]).toBe(`void:${open.stripeInvoiceId}`);
    expect(await isOnHold(env.DB, h.businessId)).toBe(false);
    expect((await listEntriesForTask(env.DB, h.task.id))[0].invoicedRef).toBeNull();
    // Voiding it again does not call Stripe again.
    expect((await voidSentInvoice(E, open.id)).status).toBe("void");
    expect(api.creates().filter((c) => new URL(c.url).pathname.endsWith("/void"))).toHaveLength(1);
  });

  it("a failed invoice can be voided; a Stripe error leaves everything as it was", async () => {
    const h = await hourlyDraft();
    const open = await openInvoice(h.invoice);
    await markInvoice(env.DB, open.id, { status: "failed", failedOn: "2026-12-15" });
    await placeHold(env.DB, { businessId: h.businessId, invoiceId: open.id, now: "2026-12-20T00:00:00.000Z" });
    setStripeFetchForTests(stripeApi({ fail: (c) => (c.url.endsWith("/void") ? stripeError("Stripe is down", 500) : null) }).f);
    await expect(voidSentInvoice(E, open.id)).rejects.toThrow("Stripe is down");
    expect((await getInvoice(env.DB, open.id))!.status).toBe("failed");
    expect(await isOnHold(env.DB, h.businessId)).toBe(true);
    expect((await listEntriesForTask(env.DB, h.task.id))[0].invoicedRef).toBe(open.ref);
    const api = stripeApi(); setStripeFetchForTests(api.f);
    expect((await voidSentInvoice(E, open.id)).status).toBe("void");
    expect(await isOnHold(env.DB, h.businessId)).toBe(false);
  });

  it("a paid invoice cannot be discarded or voided", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const h = await hourlyDraft();
    const open = await openInvoice(h.invoice);
    expect(await markInvoice(env.DB, open.id, { status: "paid", paidAt: "2026-12-20T10:00:00.000Z" })).toBe(true);
    await expect(discardInvoice(E, open.id)).rejects.toThrow("This invoice is paid, so it cannot be discarded.");
    await expect(voidSentInvoice(E, open.id)).rejects.toThrow("This invoice is paid, so it cannot be voided.");
    expect(api.calls).toHaveLength(0);
    expect((await getInvoice(env.DB, open.id))!.status).toBe("paid");
    expect((await listEntriesForTask(env.DB, h.task.id))[0].invoicedRef).toBe(open.ref);
  });

  it("each action refuses the wrong state with a plain sentence", async () => {
    const h = await hourlyDraft();
    await expect(voidSentInvoice(E, h.invoice.id)).rejects.toThrow("This invoice is a draft that was never sent: discard it instead.");
    await expect(discardInvoice(E, "no-such-invoice")).rejects.toThrow("There is no such invoice.");
    await expect(voidSentInvoice(E, "no-such-invoice")).rejects.toThrow("There is no such invoice.");
    const open = await openInvoice(h.invoice);
    await expect(discardInvoice(E, open.id)).rejects.toThrow("This invoice is open and was sent, so it is voided, not discarded.");
    await expect(voidSentInvoice({ ...env, STRIPE_SECRET_KEY: undefined } as Env, open.id)).rejects.toThrow("Stripe is not set up");
    expect((await getInvoice(env.DB, open.id))!.status).toBe("open");
  });
});
