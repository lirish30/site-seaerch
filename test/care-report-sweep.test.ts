import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import * as factsMod from "../src/worker/care/reportFacts";
import { CareReportRefused, previousMonth, startReport, sweepReports } from "../src/worker/care/reportSweep";
import { tickCare4 } from "../src/worker/care/tasks";
import { getReportFor, insertReport, listReports, upsertUptimeDay } from "../src/worker/db/careReports";
import { placeHold } from "../src/worker/db/holds";
import { markSubscription } from "../src/worker/db/subscriptions";
import { addCadence, setProjectStatus } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { insertTasks, listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { generateRecurring, sweepProjects } from "../src/worker/projects/sweep";
import "../src/worker/queue/kinds";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { newTask, resetProjectWork } from "./fixtures/projects";

// The first sweep of December in Los Angeles (Wednesday 2 December 2026, 06:00 Pacific): the CARE-4 task of 2026-12 exists, and the report is of November.
const NOW = new Date("2026-12-02T14:00:00.000Z");
const LA = "America/Los_Angeles";
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const e = env as Env;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  for (const t of ["site_incidents", "site_checks", "site_uptime_days", "care_reports", "care_page_checks", "care_runs", "care_batches", "care_updates", "helper_jobs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["ladder_steps", "billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { vi.restoreAllMocks(); });

/** The CARE-4 cadence on a project, attached at an explicit time (the real clock must not decide which month it looks old enough for): before November 2026 unless `at` says otherwise. */
async function cadence(projectId: string, at = "2026-10-15T17:00:00.000Z") {
  await addCadence(env.DB, projectId, "CARE-4");
  await env.DB.prepare(`UPDATE project_cadences SET created_at = ? WHERE project_id = ? AND template_key = 'CARE-4'`).bind(at, projectId).run();
}

/**
 * A real client with live Care and the monthly report cadence on its project; its CARE-4 task is made for the month `at` falls in (none when `task` is false). Its site has a rolled-up uptime day on `uptimeFrom`
 * (the first of November unless said, none when null): the sweep reports only months the rollup has written at least one day of.
 */
async function careClient(o: { task?: boolean; test?: boolean; at?: Date; cadenceAt?: string; uptimeFrom?: string | null } = {}) {
  const s = await seedClient({ subs: CARE, test: o.test });
  await cadence(s.project!.id, o.cadenceAt);
  const from = o.uptimeFrom === undefined ? "2026-11-01" : o.uptimeFrom;
  if (from && s.site) await upsertUptimeDay(env.DB, s.site.id, from, 288, 288);
  if (o.task !== false) await generateRecurring(e, o.at ?? NOW);
  return s;
}
const care4 = async (projectId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.cadenceKey === "CARE-4");
const reports = async () => listReports(env.DB, {});
const jobs = () => env.DB.prepare(`SELECT kind, target_id, status FROM claude_tasks ORDER BY created_at, id`).all<{ kind: string; target_id: string; status: string }>().then((r) => r.results);

describe("previousMonth", () => {
  it("is the month before the one the instant is in, in the booking zone", () => {
    expect(previousMonth(new Date("2026-01-03T20:00:00.000Z"), LA)).toBe("2025-12");
    expect(previousMonth(NOW, LA)).toBe("2026-11");
    expect(previousMonth(new Date("2026-03-15T20:00:00.000Z"), LA)).toBe("2026-02");
    // 06:30 UTC on 1 December is still 30 November in Los Angeles: the month is November, so the one before is October.
    expect(previousMonth(new Date("2026-12-01T06:30:00.000Z"), LA)).toBe("2026-10");
    expect(previousMonth(new Date("2026-12-01T08:30:00.000Z"), LA)).toBe("2026-11");
  });
});

describe("sweepReports", () => {
  it("starts the report of last month for a live Care client, queues its summary and ticks 1.1 and 1.4, once", async () => {
    const s = await careClient();
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 0 });
    const r = (await getReportFor(env.DB, s.businessId, "2026-11"))!;
    expect(r).toMatchObject({ businessId: s.businessId, period: "2026-11", status: "collecting", test: false, summary: "", approvalId: null });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.facts).toMatchObject({ version: 1, period: "2026-11", label: "November 2026", clientName: expect.any(String) }); // the frozen snapshot, as buildFacts made it
    expect(await jobs()).toEqual([{ kind: "care.report", target_id: r.id, status: "pending" }]);
    expect(r.claudeTaskId).not.toBeNull();
    const [task] = await care4(s.project!.id);
    expect(task.periodKey).toBe("2026-12");
    expect(task.checklist.map((c) => c.done)).toEqual([true, false, false, true, false, false]);

    expect(await sweepReports(e, NOW)).toEqual({ started: 0, skipped: 0 });
    expect(await sweepReports(e, new Date(NOW.getTime() + 86_400_000))).toEqual({ started: 0, skipped: 0 });
    expect(await reports()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("makes nothing for a client on billing hold, a test client, a cancelled Care project, a client with no CARE-4 task, or a task of another month or one skipped", async () => {
    /** The CARE-4 task, put on the client's project by hand (the sweep that makes them skips some of these clients, and the state that stops the report comes after the task). */
    const task = (s: Awaited<ReturnType<typeof careClient>>, periodKey = "2026-12", status: "todo" | "skipped" = "todo") =>
      insertTasks(env.DB, [newTask(s.project!.id, s.businessId, { isStep: false, phaseKey: "recurring", cadenceKey: "CARE-4", periodKey, owner: "claude_drafts", status })]);
    const good = await careClient();
    const held = await seedClient({ subs: CARE, invoice: { cents: 5000 } });
    const test = await careClient({ test: true, task: false });
    const cancelled = await careClient({ task: false });
    const none = await careClient({ task: false });
    const lastMonth = await careClient({ task: false });
    const skipped = await careClient({ task: false });
    await cadence(held.project!.id);
    for (const s of [held, test, cancelled]) await task(s);
    await task(lastMonth, "2026-11");
    await task(skipped, "2026-12", "skipped");
    await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() });
    await setProjectStatus(env.DB, cancelled.project!.id, "cancelled");

    expect(none.businessId).toBeTruthy();
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 0 });
    expect((await reports()).map((r) => r.businessId)).toEqual([good.businessId]);
    expect(await jobs()).toHaveLength(1);
  });

  it("makes nothing for a client whose Care subscription is no longer live, and starts again when it is live", async () => {
    const lapsed = await careClient();
    const past = await careClient();
    await markSubscription(env.DB, lapsed.subIds[0], { status: "cancelled" });
    await markSubscription(env.DB, past.subIds[0], { status: "past_due" }); // late on a bill is still live Care
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 0 });
    expect((await reports()).map((r) => r.businessId)).toEqual([past.businessId]);
    expect(await jobs()).toHaveLength(1);
  });

  it("makes nothing for a client whose Care began after the reported month ended, and still reports one that began inside it", async () => {
    const late = await careClient({ cadenceAt: "2026-12-01T08:00:00.000Z" }); // the first instant after November in Los Angeles
    const lateOctober = await careClient({ cadenceAt: "2026-12-01T07:59:59.999Z" }); // the last millisecond of it
    const inside = await careClient({ cadenceAt: "2026-11-20T17:00:00.000Z" }); // a partial first month
    const wayLate = await careClient({ cadenceAt: "2026-12-02T01:00:00.000Z" });
    expect(await sweepReports(e, NOW)).toEqual({ started: 2, skipped: 0 });
    expect((await reports()).map((r) => r.businessId).sort()).toEqual([inside.businessId, lateOctober.businessId].sort());
    expect(await getReportFor(env.DB, late.businessId, "2026-11")).toBeNull();
    expect(await getReportFor(env.DB, wayLate.businessId, "2026-11")).toBeNull();
    // The owner's own start is not held back by it.
    expect((await startReport(e, late.businessId, { test: false, now: NOW })).created).toBe(true);
  });

  it("builds nothing on the first sweep after a deploy mid-month (the rollup has no day of the reported month), and starts once it has one", async () => {
    // Deployed on 10 December: the rollup's first day is in the current month, so November was never measured, though the clients already have December's CARE-4 task and a cadence from before November.
    const s = await careClient({ uptimeFrom: "2026-12-02" });
    const t = await careClient({ uptimeFrom: null });
    expect(await sweepReports(e, NOW)).toEqual({ started: 0, skipped: 0 });
    expect(await reports()).toEqual([]);
    expect(await jobs()).toEqual([]);
    expect((await care4(s.project!.id))[0].checklist.map((c) => c.done)).toEqual([false, false, false, false, false, false]);
    // The owner's own start is not held back by it (the rehearsal needs it).
    expect((await startReport(e, t.businessId, { test: false, now: NOW })).created).toBe(true);
    // The rollup reaches the reported month (even its last day only): both clients are candidates, the one with a report is left alone.
    await upsertUptimeDay(env.DB, s.site!.id, "2026-11-30", 288, 288);
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 0 });
    expect((await reports()).map((r) => r.businessId).sort()).toEqual([s.businessId, t.businessId].sort());
  });

  it("builds nothing when the rollup has no day at all", async () => {
    await careClient({ uptimeFrom: null });
    expect(await sweepReports(e, NOW)).toEqual({ started: 0, skipped: 0 });
    expect(await reports()).toEqual([]);
  });

  it("one client whose facts fail is logged and does not stop the next", async () => {
    const bad = await careClient();
    const ok = await careClient();
    const real = factsMod.buildFacts;
    vi.spyOn(factsMod, "buildFacts").mockImplementation((en, businessId, ...rest) => (businessId === bad.businessId ? Promise.reject(new Error("facts exploded")) : real(en, businessId, ...rest)));
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 1 });
    expect((await reports()).map((r) => r.businessId)).toEqual([ok.businessId]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("care reports"), expect.stringContaining("facts exploded"));
    // The next daily run tries the failed client again, and the one that has its report is left alone.
    vi.mocked(factsMod.buildFacts).mockImplementation(real);
    expect(await sweepReports(e, NOW)).toEqual({ started: 1, skipped: 0 });
    expect((await reports()).map((r) => r.businessId).sort()).toEqual([bad.businessId, ok.businessId].sort());
  });

  it("starts at most 50 clients a run, and the rest the next day", async () => {
    for (let i = 0; i < 52; i++) await seedClient({ subs: CARE }).then((s) => cadence(s.project!.id));
    await upsertUptimeDay(env.DB, (await env.DB.prepare(`SELECT id FROM sites LIMIT 1`).first<{ id: string }>())!.id, "2026-11-01", 288, 288);
    await generateRecurring(e, NOW);
    vi.spyOn(factsMod, "buildFacts").mockImplementation(async (_en, businessId, period, now) => factsMod.ReportFacts.parse({
      version: 1, period, label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: businessId.slice(0, 8), sites: [], edits: null, renewals: [], generatedAt: now.toISOString(),
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await sweepReports(e, NOW)).toEqual({ started: 50, skipped: 0 });
    expect(await reports()).toHaveLength(50);
    // The cap was hit: a fixed short line says the rest wait for the next run (no client name or count of anything but the cap).
    expect(log).toHaveBeenCalledWith("care reports: 50 clients started, the rest wait for the next run");
    log.mockClear();
    expect(await sweepReports(e, new Date(NOW.getTime() + 86_400_000))).toEqual({ started: 2, skipped: 0 });
    expect(log).not.toHaveBeenCalled();
    expect(await reports()).toHaveLength(52);
    expect(await jobs()).toHaveLength(52);
  }, 60_000);

  it("a report left without its summary task (a crash between the two writes) is queued by the next sweep", async () => {
    const s = await careClient();
    const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token: "tok-left-behind", facts: { version: 1 }, test: false, now: NOW.toISOString() });
    expect(await sweepReports(e, NOW)).toEqual({ started: 0, skipped: 1 });
    expect(await jobs()).toEqual([{ kind: "care.report", target_id: report.id, status: "pending" }]);
    expect((await care4(s.project!.id))[0].checklist.map((c) => c.done)).toEqual([true, false, false, true, false, false]);
    expect(await sweepReports(e, NOW)).toEqual({ started: 0, skipped: 0 });
    expect(await jobs()).toHaveLength(1);
  });

  it("CARE-4 is no longer handed to Claude as a step: after the project sweep and the report sweep the queue holds only the care.report job", async () => {
    const s = await careClient({ task: false });
    expect(await sweepProjects(e, NOW)).toMatchObject({ recurring: 1, dispatched: 0 });
    expect(await jobs()).toEqual([]);
    await sweepReports(e, NOW);
    const r = (await getReportFor(env.DB, s.businessId, "2026-11"))!;
    expect(await jobs()).toEqual([{ kind: "care.report", target_id: r.id, status: "pending" }]);
    expect((await care4(s.project!.id))[0]).toMatchObject({ status: "todo", claudeTaskId: null });
  });
});

describe("the daily run", () => {
  it("starts the reports after the project sweep and the uptime rollup, so the last day of the month is in the report, and last of all, so a long run cannot starve the other parts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await careClient({ task: false, uptimeFrom: null });
    // 30 November (Los Angeles) is 08:00 UTC that day to 08:00 UTC the next. Only raw checks exist: nothing has rolled them up yet, and there is no CARE-4 task for December yet either.
    const t0 = Date.parse("2026-11-30T08:00:00.000Z");
    const rows = Array.from({ length: 288 }, (_, i) => env.DB.prepare(`INSERT INTO site_checks (id, site_id, checked_at, ok, status, ms, error) VALUES (?, ?, ?, 1, NULL, NULL, NULL)`).bind(crypto.randomUUID(), s.site!.id, new Date(t0 + i * 300_000).toISOString()));
    for (let i = 0; i < rows.length; i += 90) await env.DB.batch(rows.slice(i, i + 90));
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_uptime_days`).first<{ n: number }>()).toEqual({ n: 0 });

    await runScheduled(e, DAILY_CRON, NOW);

    const names = log.mock.calls.map((c) => String(c[0]));
    expect(names.indexOf("care reports")).toBeGreaterThan(names.indexOf("project sweep"));
    expect(names.indexOf("care reports")).toBeGreaterThan(names.indexOf("domain expiry"));
    expect(names.indexOf("project sweep")).toBeGreaterThanOrEqual(0);
    for (const part of ["care updates", "care backstop", "certificates"]) expect(names.indexOf("care reports"), part).toBeGreaterThan(names.indexOf(part));
    expect(names.indexOf("certificates")).toBeGreaterThanOrEqual(0);
    const r = (await getReportFor(env.DB, s.businessId, "2026-11"))!;
    expect(r).toBeTruthy();
    expect((r.facts as factsMod.ReportFacts).sites).toMatchObject([{ coveredDays: 1, uptimePercent: 100, monitoredSince: "2026-11-30" }]);
  });
});

describe("startReport", () => {
  it("makes the report of last month for a test client, flagged test, and a second call returns the same one", async () => {
    const s = await careClient({ test: true, task: false });
    const first = await startReport(e, s.businessId, { test: true, now: NOW });
    expect(first.created).toBe(true);
    expect(first.report).toMatchObject({ businessId: s.businessId, period: "2026-11", test: true, status: "collecting" });
    expect(await jobs()).toEqual([{ kind: "care.report", target_id: first.report.id, status: "pending" }]);
    const again = await startReport(e, s.businessId, { test: true, now: NOW });
    expect(again).toMatchObject({ created: false });
    expect(again.report.id).toBe(first.report.id);
    expect(await reports()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("works for a real client on hold too (the owner asked for it), and refuses a client with no live Care project", async () => {
    const real = await seedClient({ subs: CARE, invoice: { cents: 5000 } });
    await cadence(real.project!.id);
    await placeHold(env.DB, { businessId: real.businessId, invoiceId: real.invoice!.id, now: NOW.toISOString() });
    expect((await startReport(e, real.businessId, { test: false, now: NOW })).created).toBe(true);

    const plain = await seedClient({ subs: CARE }); // no CARE-4 cadence
    await expect(startReport(e, plain.businessId, { test: false, now: NOW })).rejects.toBeInstanceOf(CareReportRefused);
    const gone = await seedClient({ subs: CARE });
    await cadence(gone.project!.id);
    await setProjectStatus(env.DB, gone.project!.id, "cancelled");
    await expect(startReport(e, gone.businessId, { test: false, now: NOW })).rejects.toThrow(/no live Care project/);
    expect(await reports()).toHaveLength(1);
  });
});

describe("tickCare4", () => {
  it("ticks only the steps asked for on a task that lines up with the template, never un-ticks, and leaves a done task alone", async () => {
    const s = await careClient();
    const [task] = await care4(s.project!.id);
    expect(await tickCare4(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(true);
    expect(await tickCare4(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false);
    expect((await care4(s.project!.id))[0].checklist.map((c) => c.done)).toEqual([true, false, false, false, false, false]);
    expect(await tickCare4(e, s.businessId, "2026-11", ["1.4"], NOW)).toBe(false); // another month's task
    // A checklist that does not line up with the template (the template was edited after the task was made) is left alone.
    await env.DB.prepare(`UPDATE tasks SET checklist = ? WHERE id = ?`).bind(JSON.stringify(task.checklist.slice(0, 3)), task.id).run();
    expect(await tickCare4(e, s.businessId, "2026-12", ["1.4"], NOW)).toBe(false);
    await env.DB.prepare(`UPDATE tasks SET checklist = ?, status = 'done' WHERE id = ?`).bind(JSON.stringify(task.checklist), task.id).run();
    expect(await tickCare4(e, s.businessId, "2026-12", ["1.4"], NOW)).toBe(false);
  });

  it("logs and swallows an error", async () => {
    const s = await careClient();
    await env.DB.prepare(`UPDATE sop_templates SET key = 'CARE-4-moved' WHERE key = 'CARE-4'`).run();
    expect(await tickCare4(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false); // no template: nothing to line up with
    const broken = { ...e, DB: new Proxy(env.DB, { get(t, p) { if (p === "prepare") return () => { throw new Error("db down"); }; const v = (t as never)[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) } as Env;
    expect(await tickCare4(broken, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("care tasks"), expect.stringContaining("db down"));
  });
});

describe("POST /api/clients/:id/care-report", () => {
  const ctx = () => createExecutionContext();
  let cookie = "";
  const call = async (path: string, session = true) => {
    if (session && !cookie) {
      const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    }
    return worker.fetch(new Request(`https://x/api${path}`, { method: "POST", headers: session ? { cookie } : {} }), E, ctx());
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts the report for the client and says which one; a second call answers the same report", async () => {
    const s = await careClient({ task: false });
    const r = await call(`/clients/${s.businessId}/care-report`);
    expect(r.status).toBe(201);
    const body = (await r.json()) as { report: { id: string; status: string; period: string } };
    expect(body).toEqual({ report: { id: expect.any(String), status: "collecting", period: "2026-11" } });
    const again = await call(`/clients/${s.businessId}/care-report`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as typeof body).report.id).toBe(body.report.id);
  });

  it("flags a rehearsal client's report test", async () => {
    const s = await careClient({ test: true, task: false });
    expect((await call(`/clients/${s.businessId}/care-report`)).status).toBe(201);
    expect((await getReportFor(env.DB, s.businessId, "2026-11"))!.test).toBe(true);
  });

  it("needs the owner's session, 404s an unknown client, and 409s a client with no live Care project in a plain sentence", async () => {
    const s = await careClient({ task: false });
    expect((await call(`/clients/${s.businessId}/care-report`, false)).status).toBe(401);
    expect((await call(`/clients/no-such-client/care-report`)).status).toBe(404);
    const plain = await seedClient({ subs: CARE });
    const r = await call(`/clients/${plain.businessId}/care-report`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/no live Care project/);
    expect(await reports()).toEqual([]);
  });
});
