import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditRequest } from "../src/worker/care/editRequest";
import { editLedger } from "../src/worker/care/ledger";
import { placeHold } from "../src/worker/db/holds";
import { createProject } from "../src/worker/db/projects";
import { ensureSeedSops, saveTemplate, getTemplate, templatesForPackages } from "../src/worker/db/sops";
import { getTask, listTasks } from "../src/worker/db/tasks";
import { insertEntry } from "../src/worker/db/time";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

// The CARE-3 edit request: one non-billable task on the client's live Care project, its checklist copied from the CARE-3 template.
const NOW = new Date("2026-11-18T18:00:00.000Z");
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const STEPS = [
  "Log the request (Claude)", "Check the scope (Claude drafts → Logan approves)", "Make the change and take before and after pictures (Claude)",
  "Approve, publish and reply (Claude drafts → Logan approves)", "Log the minutes (Claude)",
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { vi.useRealTimers(); });

/** A real client on Care with a live Care project (and its build project too, which must never be picked). */
async function careClient(o: { carePlan?: boolean; invoice?: boolean } = {}) {
  const s = await seedClient({ subs: CARE, ...(o.invoice ? { invoice: { cents: 10_000 } } : {}) });
  const care = o.carePlan === false ? null : (await createProject(env.DB, {
    businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false,
    startedAt: "2026-10-01T10:00:00.000Z",
  })).project;
  return { ...s, care };
}

describe("createEditRequest", () => {
  it("makes one task flagged as an edit request, not billable, with the five CARE-3 steps as its checklist, on the live Care project", async () => {
    const s = await careClient();
    const r = await createEditRequest(env, s.businessId, { title: "Change the phone number in the footer", now: NOW });
    expect(r).toEqual({ taskId: expect.any(String) });
    const task = (await getTask(env.DB, (r as { taskId: string }).taskId))!;
    expect(task).toMatchObject({
      projectId: s.care!.id, businessId: s.businessId, title: "Change the phone number in the footer", isStep: false, editRequest: true, billable: false, changeOrderId: null, cadenceKey: null,
      periodKey: null, stepKey: null, status: "todo", owner: "logan",
    });
    expect(task.checklist).toEqual(STEPS.map((text) => ({ text, done: false })));
    expect((await listTasks(env.DB, s.project!.id)).filter((t) => t.editRequest)).toEqual([]);
  });

  it("two requests make two tasks", async () => {
    const s = await careClient();
    const a = await createEditRequest(env, s.businessId, { title: "Swap the hero photo", now: NOW });
    const b = await createEditRequest(env, s.businessId, { title: "Swap the hero photo", now: NOW });
    expect((a as { taskId: string }).taskId).not.toBe((b as { taskId: string }).taskId);
    expect((await listTasks(env.DB, s.care!.id)).filter((t) => t.editRequest)).toHaveLength(2);
  });

  it("cleans the title to 120 characters and never keeps control characters", async () => {
    const s = await careClient();
    const r = await createEditRequest(env, s.businessId, { title: `  Fix\u0000 the ${"long ".repeat(40)}title  `, now: NOW });
    const task = (await getTask(env.DB, (r as { taskId: string }).taskId))!;
    expect(task.title.length).toBeLessThanOrEqual(120);
    expect(task.title.startsWith("Fix the long")).toBe(true);
    expect(task.title).not.toContain("\u0000");
  });

  it("copies the CARE-3 template as it is now, so Logan's own edit of the steps is what the checklist says", async () => {
    const s = await careClient();
    const tpl = (await getTemplate(env.DB, "CARE-3"))!;
    await saveTemplate(env.DB, { ...tpl, steps: tpl.steps.map((st, i) => (i === 0 ? { ...st, title: "Write the request down" } : st)) });
    const r = await createEditRequest(env, s.businessId, { title: "Edit", now: NOW });
    expect((await getTask(env.DB, (r as { taskId: string }).taskId))!.checklist[0]).toEqual({ text: "Write the request down (Claude)", done: false });
  });

  it("works on a database that has no CARE-3 yet (the seed is put in first)", async () => {
    const s = await careClient();
    await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
    const r = await createEditRequest(env, s.businessId, { title: "Edit", now: NOW });
    expect((await getTask(env.DB, (r as { taskId: string }).taskId))!.checklist).toHaveLength(5);
  });

  it("refuses with a plain sentence for a client with no live Care project, one on a billing hold and an empty title, and makes nothing", async () => {
    const none = await careClient({ carePlan: false });
    const noCare = await createEditRequest(env, none.businessId, { title: "Edit", now: NOW });
    expect(noCare).toEqual({ refused: expect.stringMatching(/no live Care project/) });

    const held = await careClient({ invoice: true });
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() })).toBe(true);
    expect(await createEditRequest(env, held.businessId, { title: "Edit", now: NOW })).toEqual({ refused: expect.stringMatching(/billing hold/) });

    const ok = await careClient();
    for (const title of ["", "   ", "\u0000\u0007"]) expect(await createEditRequest(env, ok.businessId, { title, now: NOW }), JSON.stringify(title)).toEqual({ refused: expect.stringMatching(/title/) });

    for (const s of [none, held, ok]) expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE business_id = ? AND edit_request = 1`).bind(s.businessId).first<{ n: number }>())!.n).toBe(0);
  });

  it("is not billable, so an entry on it counts toward the ledger only when it is not billable time", async () => {
    const s = await careClient();
    const taskId = ((await createEditRequest(env, s.businessId, { title: "Edit", now: NOW })) as { taskId: string }).taskId;
    const entry = (minutes: number, billable: boolean, day: string) => insertEntry(env.DB, {
      taskId, projectId: s.care!.id, businessId: s.businessId, startedAt: `2026-11-${day}T18:00:00.000Z`, endedAt: new Date(Date.parse(`2026-11-${day}T18:00:00.000Z`) + minutes * 60_000).toISOString(),
      minutes, billable, note: "", source: "manual",
    });
    await entry(20, false, "10");
    await entry(40, true, "11");
    expect(await editLedger(env, s.businessId, "2026-11", "America/Los_Angeles")).toMatchObject({ usedMinutes: 20, allowanceMinutes: 60, state: "ok" });
  });
});

describe("CARE-3 as a template", () => {
  it("is never started as a project for a Care plan", async () => {
    expect((await templatesForPackages(env.DB, ["care", "care_plus", "care_fallback"])).map((t) => t.key)).toEqual(["CARE-0"]);
  });
});
