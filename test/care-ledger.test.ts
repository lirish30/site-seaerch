import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { editLedger, EDIT_ALLOWANCE_MINUTES, WARN_AT } from "../src/worker/care/ledger";
import { insertTasks } from "../src/worker/db/tasks";
import { insertEntry } from "../src/worker/db/time";
import { markSubscription } from "../src/worker/db/subscriptions";
import { buildToday } from "../src/worker/today";
import { seedClient, type SubSpec } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { newTask, resetProjectWork } from "./fixtures/projects";

const LA = "America/Los_Angeles";
/** Wednesday 18 November 2026, 10:00 in Los Angeles. */
const NOW = new Date("2026-11-18T18:00:00.000Z");
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const t of ["site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => { vi.useRealTimers(); });

type Client = Awaited<ReturnType<typeof seedClient>>;

/** One task on the client's project and its time: `edit` marks it an edit request. */
async function taskOf(s: Client, o: { edit?: boolean; stepKey?: string; cadenceKey?: string | null; changeOrder?: boolean } = {}) {
  const [t] = await insertTasks(env.DB, [newTask(s.project!.id, s.businessId, {
    editRequest: o.edit ?? true, stepKey: o.stepKey ?? null, isStep: false, cadenceKey: o.cadenceKey ?? null, title: "Edit request",
  })]);
  return t;
}
async function logged(s: Client, taskId: string, minutes: number, startedAt: string, o: { billable?: boolean } = {}) {
  return insertEntry(env.DB, {
    taskId, projectId: s.project!.id, businessId: s.businessId, startedAt, endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), minutes,
    billable: o.billable ?? false, note: "", source: "manual",
  });
}
/** A Care client with an edit task and `minutes` of edit time in November 2026. */
async function clientWith(minutes: number, subs: SubSpec[] = CARE) {
  const s = await seedClient({ subs });
  const t = await taskOf(s);
  if (minutes > 0) await logged(s, t.id, minutes, "2026-11-10T18:00:00.000Z");
  return { s, t };
}

describe("the allowance", () => {
  it("is one hour on Care and Care fallback and three on Care Plus, warning at 80%", () => {
    expect(EDIT_ALLOWANCE_MINUTES).toEqual({ care: 60, care_plus: 180, care_fallback: 60 });
    expect(WARN_AT).toBe(0.8);
  });
});

describe("editLedger", () => {
  it("is ok at 47 of 60 minutes, warn at 48 (80%) and over at 61, which it reports as used", async () => {
    const a = await clientWith(47);
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 47, percent: 78, state: "ok" });
    const b = await clientWith(48);
    expect(await editLedger(env, b.s.businessId, "2026-11", LA)).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 48, percent: 80, state: "warn" });
    const c = await clientWith(60);
    expect(await editLedger(env, c.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 60, percent: 100, state: "warn" });
    const d = await clientWith(61);
    expect(await editLedger(env, d.s.businessId, "2026-11", LA)).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 61, percent: 101, state: "over" });
  });

  it("uses the Care Plus allowance of 180 minutes", async () => {
    const a = await clientWith(100, [{ key: "care_plus" as const, monthlyCents: 24_900 }]);
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ allowanceMinutes: 180, usedMinutes: 100, percent: 55, state: "ok" });
  });

  it("is ok with nothing logged, and adds up several entries on several edit tasks", async () => {
    const a = await clientWith(0);
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 0, percent: 0, state: "ok" });
    const t2 = await taskOf(a.s);
    await logged(a.s, a.t.id, 20, "2026-11-02T18:00:00.000Z");
    await logged(a.s, t2.id, 25, "2026-11-20T18:00:00.000Z");
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 45, state: "ok" });
  });

  it("puts an entry in the month it started, by the booking zone, not UTC", async () => {
    const a = await clientWith(0);
    // 23:50 on 30 November in Los Angeles is 07:50 UTC on 1 December; it ends at 00:20 on 1 December local.
    await logged(a.s, a.t.id, 30, "2026-12-01T07:50:00.000Z");
    // 00:10 on 1 December local is 08:10 UTC; 17:00 on 31 October local is 00:00 UTC on 1 November.
    await logged(a.s, a.t.id, 7, "2026-12-01T08:10:00.000Z");
    await logged(a.s, a.t.id, 5, "2026-11-01T00:30:00.000Z");
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 30 });
    expect(await editLedger(env, a.s.businessId, "2026-12", LA)).toMatchObject({ usedMinutes: 7 });
    expect(await editLedger(env, a.s.businessId, "2026-10", LA)).toMatchObject({ usedMinutes: 5 });
  });

  it("never divides by an allowance of 0: percent is null and any time is over", async () => {
    const a = await clientWith(0);
    const was = EDIT_ALLOWANCE_MINUTES.care;
    EDIT_ALLOWANCE_MINUTES.care = 0;
    try {
      expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toEqual({ month: "2026-11", allowanceMinutes: 0, usedMinutes: 0, percent: null, state: "ok" });
      await logged(a.s, a.t.id, 5, "2026-11-10T18:00:00.000Z");
      expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toEqual({ month: "2026-11", allowanceMinutes: 0, usedMinutes: 5, percent: null, state: "over" });
    } finally { EDIT_ALLOWANCE_MINUTES.care = was; }
  });

  it("leaves out a billable change-order entry, CARE-1 and CARE-5 task time, and another client's edit time", async () => {
    const a = await clientWith(10);
    const co = await taskOf(a.s, { edit: false });
    await logged(a.s, co.id, 90, "2026-11-11T18:00:00.000Z", { billable: true });
    const care1 = await taskOf(a.s, { edit: false, cadenceKey: "CARE-1" });
    await logged(a.s, care1.id, 40, "2026-11-12T18:00:00.000Z");
    const care5 = await taskOf(a.s, { edit: false, cadenceKey: "CARE-5" });
    await logged(a.s, care5.id, 40, "2026-11-13T18:00:00.000Z");
    const other = await clientWith(55);
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 10, state: "ok" });
    expect(await editLedger(env, other.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 55 });
  });

  it("leaves out a billable entry even on an edit-request task", async () => {
    const a = await clientWith(10);
    await logged(a.s, a.t.id, 45, "2026-11-11T18:00:00.000Z", { billable: true });
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 10, state: "ok" });
  });

  it("counts an entry only toward the client of its task, even if the entry names another", async () => {
    const a = await clientWith(0);
    const other = await clientWith(0);
    // The entry says it belongs to `other`, on a task of `a`.
    await insertEntry(env.DB, {
      taskId: a.t.id, projectId: other.s.project!.id, businessId: other.s.businessId, startedAt: "2026-11-10T18:00:00.000Z", endedAt: "2026-11-10T18:30:00.000Z", minutes: 30,
      billable: false, note: "", source: "manual",
    });
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 0 });
    expect(await editLedger(env, other.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 0 });
  });

  it("is null without a live Care plan: none, a non-Care plan, a test plan, or one that has ended", async () => {
    const none = await seedClient();
    expect(await editLedger(env, none.businessId, "2026-11", LA)).toBeNull();
    const web = await seedClient({ subs: [{ key: "website_subscription", monthlyCents: 9_900 }] });
    expect(await editLedger(env, web.businessId, "2026-11", LA)).toBeNull();
    const test = await seedClient({ test: true, subs: CARE });
    expect(await editLedger(env, test.businessId, "2026-11", LA)).toBeNull();
    const ended = await seedClient({ subs: CARE });
    await markSubscription(env.DB, ended.subIds[0], { status: "cancelled" });
    expect(await editLedger(env, ended.businessId, "2026-11", LA)).toBeNull();
    expect(await editLedger(env, "nobody", "2026-11", LA)).toBeNull();
  });

  it("still counts for a Care plan that is late on a bill", async () => {
    const a = await clientWith(50);
    await markSubscription(env.DB, a.s.subIds[0], { status: "past_due" });
    expect(await editLedger(env, a.s.businessId, "2026-11", LA)).toMatchObject({ usedMinutes: 50, state: "warn" });
  });
});

describe("the Today row", () => {
  const rows = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "care_edit_hours");

  it("appears once at 60 from 80% on, names the percent, and becomes 64 when over", async () => {
    const ok = await clientWith(47);
    expect(await rows()).toEqual([]);
    await logged(ok.s, ok.t.id, 1, "2026-11-11T18:00:00.000Z");
    const name = (await env.DB.prepare(`SELECT name FROM businesses WHERE id = ?`).bind(ok.s.businessId).first<{ name: string }>())!.name;
    expect(await rows()).toEqual([{
      id: `care_edit_hours:${ok.s.businessId}`, kind: "care_edit_hours", businessId: ok.s.businessId, businessName: name, reason: `${name} has used 80% of this month's edit hours`, due: null, priority: 60,
    }]);
    // Two edit tasks do not make two rows.
    const t2 = await taskOf(ok.s);
    await logged(ok.s, t2.id, 1, "2026-11-12T18:00:00.000Z");
    expect(await rows()).toHaveLength(1);
    await logged(ok.s, t2.id, 12, "2026-11-13T18:00:00.000Z");
    expect(await rows()).toEqual([expect.objectContaining({ reason: `${name} has used 101% of this month's edit hours`, priority: 64 })]);
  });

  it("looks only at the current month in the booking zone", async () => {
    const a = await clientWith(0);
    await logged(a.s, a.t.id, 59, "2026-10-20T18:00:00.000Z");
    expect(await rows()).toEqual([]);
    // 23:50 on 30 November local is December in UTC, and November here.
    const early = new Date("2026-12-01T07:55:00.000Z");
    await logged(a.s, a.t.id, 50, "2026-11-30T20:00:00.000Z");
    expect((await buildToday(env.DB, early)).filter((i) => i.kind === "care_edit_hours")).toHaveLength(1);
    expect((await buildToday(env.DB, new Date("2026-12-01T08:05:00.000Z"))).filter((i) => i.kind === "care_edit_hours")).toEqual([]);
  });

  it("never shows for a test client or a client without a live Care plan", async () => {
    const test = await seedClient({ test: true, subs: CARE });
    const tt = await taskOf(test);
    await logged(test, tt.id, 55, "2026-11-10T18:00:00.000Z");
    const none = await seedClient();
    const nt = await taskOf(none);
    await logged(none, nt.id, 55, "2026-11-10T18:00:00.000Z");
    expect(await rows()).toEqual([]);
  });

  it("shows for a Care client whose build project is over", async () => {
    const a = await clientWith(55);
    await env.DB.prepare(`UPDATE projects SET status = 'done' WHERE business_id = ?`).bind(a.s.businessId).run();
    expect(await rows()).toHaveLength(1);
  });
});

describe("GET /api/clients/:id/edit-ledger", () => {
  let cookie = "";
  const call = async (path: string) => {
    if (!cookie) {
      const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, createExecutionContext());
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    }
    return worker.fetch(new Request(`https://x/api${path}`, { headers: { cookie } }), E, createExecutionContext());
  };

  it("needs the owner's session", async () => {
    const a = await clientWith(10);
    const r = await worker.fetch(new Request(`https://x/api/clients/${a.s.businessId}/edit-ledger`), E, createExecutionContext());
    expect(r.status).toBe(401);
  });

  it("returns this month's ledger by default and any month asked for", async () => {
    const a = await clientWith(48);
    const now = await call(`/clients/${a.s.businessId}/edit-ledger`);
    expect(now.status).toBe(200);
    expect(await now.json()).toEqual({ ledger: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 48, percent: 80, state: "warn" } });
    const oct = await call(`/clients/${a.s.businessId}/edit-ledger?month=2026-10`);
    expect(await oct.json()).toEqual({ ledger: { month: "2026-10", allowanceMinutes: 60, usedMinutes: 0, percent: 0, state: "ok" } });
  });

  it("is a null ledger without live Care, 400 for a bad month and 404 for an unknown or test client", async () => {
    const none = await seedClient();
    const r = await call(`/clients/${none.businessId}/edit-ledger`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ledger: null });
    expect((await call(`/clients/${none.businessId}/edit-ledger?month=2026-13`)).status).toBe(400);
    expect((await call(`/clients/${none.businessId}/edit-ledger?month=november`)).status).toBe(400);
    expect((await call(`/clients/nobody/edit-ledger`)).status).toBe(404);
    const test = await seedClient({ test: true });
    expect((await call(`/clients/${test.businessId}/edit-ledger`)).status).toBe(404);
  });
});
