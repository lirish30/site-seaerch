import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hourlyInvoice } from "../src/worker/billing/hourly";
import { discardDraftInvoice, getInvoice, listInvoices } from "../src/worker/db/invoices";
import { getPackage } from "../src/worker/db/packages";
import { insertPlanned, markSubscription } from "../src/worker/db/subscriptions";
import { insertTasks } from "../src/worker/db/tasks";
import { insertEntry, listEntriesForTask, releaseTimeEntries, unbilledBillableMinutes, type NewEntry } from "../src/worker/db/time";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { readyToSend } from "./fixtures/documents";
import { newTask, seedProject } from "./fixtures/projects";

const e = env as Env;
const NOW = new Date("2026-12-10T12:00:00.000Z");
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); await env.DB.prepare(`DELETE FROM time_entries`).run(); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const waiting = async (invoiceId: string) => (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'invoice.send' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoiceId).all<{ id: string }>()).results;

async function seed() {
  const s = await seedProject();
  const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Tweak the footer" })]);
  const entry = (minutes: number, o: Partial<NewEntry> = {}): NewEntry => ({
    taskId: task.id, projectId: s.project.id, businessId: s.businessId, startedAt: "2026-12-03T17:00:00.000Z", endedAt: "2026-12-03T18:00:00.000Z", minutes, billable: true, note: "", source: "manual", ...o,
  });
  return { ...s, task, entry };
}

describe("hourly invoices", () => {
  it("hourly: 70 minutes of billable time becomes 90 minutes at the hourly price", async () => {
    const s = await seed();
    const hourly = (await getPackage(env.DB, "hourly"))!;
    const a = await insertEntry(env.DB, s.entry(40));
    const b = await insertEntry(env.DB, s.entry(30));
    const unbillable = await insertEntry(env.DB, s.entry(20, { billable: false }));
    const running = await insertEntry(env.DB, s.entry(0, { source: "timer", endedAt: null }));
    expect(await unbilledBillableMinutes(env.DB, s.project.id)).toEqual({ entryIds: expect.arrayContaining([a.id, b.id]), minutes: 70 });

    const made = (await hourlyInvoice(e, { projectId: s.project.id, now: NOW }))!;
    expect(made.invoice).toMatchObject({
      kind: "hourly", status: "draft", ref: `hourly:${s.project.id}:1`, test: false, projectId: s.project.id, businessId: s.businessId, dealId: s.dealId, documentId: s.documentId,
      stripeInvoiceId: null, amountCents: Math.round(hourly.priceCents * 1.5),
    });
    expect(made.invoice.amountCents).toBe(18750);
    expect(made.invoice.lines).toEqual([{ description: "Hourly work: 1.5 hours at $125 an hour", amountCents: 18750 }]);
    expect(made.approval).toMatchObject({ kind: "invoice.send", status: "pending", record_type: "project", record_id: s.project.id });
    expect(await waiting(made.invoice.id)).toHaveLength(1);

    // Only the two billable, finished entries were tagged.
    const tags = Object.fromEntries((await listEntriesForTask(env.DB, s.task.id)).map((x) => [x.id, x.invoicedRef]));
    expect(tags).toEqual({ [a.id]: made.invoice.ref, [b.id]: made.invoice.ref, [unbillable.id]: null, [running.id]: null });
    // Nothing is left to bill until more time is logged, and that goes on the next invoice.
    expect(await unbilledBillableMinutes(env.DB, s.project.id)).toEqual({ entryIds: [], minutes: 0 });
    expect(await hourlyInvoice(e, { projectId: s.project.id, now: NOW })).toBeNull();
    await insertEntry(env.DB, s.entry(31));
    const next = (await hourlyInvoice(e, { projectId: s.project.id, now: NOW }))!;
    expect(next.invoice.ref).toBe(`hourly:${s.project.id}:2`);
    expect(next.invoice.amountCents).toBe(Math.round(hourly.priceCents * 1)); // 31 minutes is two half-hour blocks
  });

  it("hourly: a Care client with an active Care subscription gets the alt rate", async () => {
    const s = await seed();
    const hourly = (await getPackage(env.DB, "hourly"))!;
    expect(hourly.altPriceCents).toBe(9500);
    await insertEntry(env.DB, s.entry(60));
    const { subscription } = await insertPlanned(env.DB, {
      businessId: s.businessId, documentId: s.documentId!, projectId: null, packageKey: "care", packageVersion: 1, monthlyCents: 12900, startsWhen: "launch", firstChargeOn: null,
      termMonths: null, termEndsOn: null, endAction: "none", test: false,
    });
    // A subscription that is not active changes nothing.
    const first = (await hourlyInvoice(e, { projectId: s.project.id, now: NOW }))!;
    expect(first.invoice.amountCents).toBe(12500);
    expect(await discardDraftInvoice(env.DB, first.invoice.id)).toBe(true);
    await releaseTimeEntries(env.DB, first.invoice.ref);

    await markSubscription(env.DB, subscription.id, { status: "active" });
    const care = (await hourlyInvoice(e, { projectId: s.project.id, now: NOW }))!;
    expect(care.invoice.amountCents).toBe(9500);
    expect(care.invoice.lines[0].description).toBe("Hourly work: 1 hour at $95 an hour (Care rate)");
  });

  it("hourly: the same entries cannot go on two drafts, even when two requests race", async () => {
    const s = await seed();
    for (const m of [25, 25, 25, 10]) await insertEntry(env.DB, s.entry(m));
    const results = await Promise.all([hourlyInvoice(e, { projectId: s.project.id, now: NOW }), hourlyInvoice(e, { projectId: s.project.id, now: NOW })]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const invoices = await listInvoices(env.DB, { kinds: ["hourly"], projectId: s.project.id });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].amountCents).toBe(Math.round(12500 * 1.5)); // 85 minutes is three blocks
    const entries = await listEntriesForTask(env.DB, s.task.id);
    expect(entries.every((x) => x.invoicedRef === invoices[0].ref)).toBe(true);
    expect(await waiting(invoices[0].id)).toHaveLength(1);
  });

  it("hourly: an entry already on an invoice is never claimed again", async () => {
    const s = await seed();
    const a = await insertEntry(env.DB, s.entry(30));
    await env.DB.prepare(`UPDATE time_entries SET invoiced_ref = 'hourly:other:1' WHERE id = ?`).bind(a.id).run();
    expect(await hourlyInvoice(e, { projectId: s.project.id, now: NOW })).toBeNull();
    expect((await listEntriesForTask(env.DB, s.task.id))[0].invoicedRef).toBe("hourly:other:1");
    expect(await releaseTimeEntries(env.DB, "hourly:other:1")).toBe(1);
    expect((await getInvoice(env.DB, "nope"))).toBeNull();
  });

  it("hourly: nothing to bill returns null", async () => {
    const s = await seed();
    expect(await hourlyInvoice(e, { projectId: s.project.id, now: NOW })).toBeNull();
    await insertEntry(env.DB, s.entry(45, { billable: false }));
    await insertEntry(env.DB, s.entry(0, { source: "timer", endedAt: null }));
    await insertEntry(env.DB, s.entry(0)); // a finished entry with no minutes
    expect(await hourlyInvoice(e, { projectId: s.project.id, now: NOW })).toBeNull();
    expect(await hourlyInvoice(e, { projectId: "no-such-project", now: NOW })).toBeNull();
    expect(await listInvoices(env.DB, { kinds: ["hourly"], projectId: s.project.id })).toHaveLength(0);
  });

  it("hourly: a test project is not billed", async () => {
    const s = await seedProject({ test: true });
    const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId)]);
    await insertEntry(env.DB, { taskId: task.id, projectId: s.project.id, businessId: s.businessId, startedAt: "2026-12-03T17:00:00.000Z", endedAt: "2026-12-03T18:00:00.000Z", minutes: 60, billable: true, note: "", source: "manual" });
    expect(await hourlyInvoice(e, { projectId: s.project.id, now: NOW })).toBeNull();
    expect((await listEntriesForTask(env.DB, task.id))[0].invoicedRef).toBeNull();
  });
});
