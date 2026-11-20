import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, setPaid, signDocument } from "../src/worker/db/documents";
import { addCadence, setProjectStatus } from "../src/worker/db/projects";
import { ensureSeedSops, saveTemplate } from "../src/worker/db/sops";
import { insertTasks, listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { generateRecurring, sweepProjects } from "../src/worker/projects/sweep";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { OWNER_LABEL, type OwnerTag, type SopStep, type SopTemplateInput } from "../src/worker/sop/model";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import { startTimer } from "../src/worker/time/service";
import { seedOrder, sendOrder } from "./fixtures/changeorders";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";
import "../src/worker/queue/kinds";

const e = env as Env;
const DAY = 86_400_000;
/** A Thursday afternoon in Los Angeles: the week of Monday 16 November, ISO week 47 of 2026. */
const NOW = new Date("2026-11-19T22:00:00.000Z");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await ensureSeedSops(env.DB);
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
  await env.DB.prepare(`UPDATE documents SET paid_at = NULL`).run(); // a paid proposal left by another test has no project now (the reset above), and the sweep would start one
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); setMailDeps(null); vi.restoreAllMocks(); });

const cadenceTasks = async (projectId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.cadenceKey !== null);
async function withCadence(key: string, o: Parameters<typeof seedProject>[0] = {}) {
  const s = await seedProject({ bare: true, ...o });
  await addCadence(env.DB, s.project.id, key);
  return s;
}

describe("generateRecurring", () => {
  it("a weekly cadence makes one task for this week and a rerun makes none", async () => {
    const s = await withCadence("CARE-1");
    expect(await generateRecurring(e, NOW)).toBe(1);
    const [t] = await cadenceTasks(s.project.id);
    expect(t).toMatchObject({
      title: "Care weekly update: Week of Nov 16", isStep: false, stepKey: null, cadenceKey: "CARE-1", periodKey: "2026-W47", dueOn: "2026-11-18", status: "todo", billable: false,
      projectId: s.project.id, businessId: s.businessId, clientSummary: null,
    });
    expect(await generateRecurring(e, new Date(NOW.getTime() + 2 * DAY))).toBe(0); // the same week, a day later
    expect(await generateRecurring(e, NOW)).toBe(0);
    expect(await cadenceTasks(s.project.id)).toHaveLength(1);
  });

  it("a monthly cadence makes its task on the day set, once a month", async () => {
    const s = await withCadence("CARE-4");
    expect(await generateRecurring(e, NOW)).toBe(1);
    expect(await cadenceTasks(s.project.id)).toMatchObject([{ title: "Care monthly report: November 2026", periodKey: "2026-11", dueOn: "2026-11-05" }]);
    expect(await generateRecurring(e, new Date("2026-11-30T20:00:00.000Z"))).toBe(0);
    expect(await generateRecurring(e, new Date("2026-12-01T20:00:00.000Z"))).toBe(1);
    expect((await cadenceTasks(s.project.id)).map((t) => t.periodKey)).toEqual(["2026-11", "2026-12"]);
  });

  it("a new week makes a new task", async () => {
    const s = await withCadence("CARE-1");
    await generateRecurring(e, NOW);
    expect(await generateRecurring(e, new Date(NOW.getTime() + 7 * DAY))).toBe(1);
    expect((await cadenceTasks(s.project.id)).map((t) => [t.title, t.periodKey, t.dueOn])).toEqual([
      ["Care weekly update: Week of Nov 16", "2026-W47", "2026-11-18"],
      ["Care weekly update: Week of Nov 23", "2026-W48", "2026-11-25"],
    ]);
  });

  it("the week is the one in the booking time zone: Sunday 23:30 Pacific is still that Sunday's week", async () => {
    const s = await withCadence("CARE-1");
    await generateRecurring(e, new Date("2026-11-23T07:30:00.000Z"));
    expect((await cadenceTasks(s.project.id)).map((t) => t.periodKey)).toEqual(["2026-W47"]);
  });

  it("a paused, done, cancelled or test project generates nothing", async () => {
    const paused = await withCadence("CARE-1");
    await setProjectStatus(env.DB, paused.project.id, "paused", { reason: "overdue" });
    const done = await withCadence("CARE-1");
    await setProjectStatus(env.DB, done.project.id, "done");
    const cancelled = await withCadence("CARE-1");
    await setProjectStatus(env.DB, cancelled.project.id, "cancelled");
    const test = await withCadence("CARE-1", { test: true });
    expect(await generateRecurring(e, NOW)).toBe(0);
    for (const s of [paused, done, cancelled, test]) expect(await cadenceTasks(s.project.id)).toEqual([]);
    // The project that is resumed picks the period up.
    await setProjectStatus(env.DB, paused.project.id, "active");
    expect(await generateRecurring(e, NOW)).toBe(1);
  });

  it("a cadence on a template that is switched off, missing, or not recurring makes nothing, and does not stop the rest", async () => {
    const off = await withCadence("CARE-1");
    await env.DB.prepare(`UPDATE sop_templates SET active = 0 WHERE key = 'CARE-1'`).run();
    const gone = await withCadence("NO-SUCH");
    const notRecurring = await withCadence("BUILD");
    const ok = await withCadence("CARE-4");
    expect(await generateRecurring(e, NOW)).toBe(1);
    for (const s of [off, gone, notRecurring]) expect(await cadenceTasks(s.project.id)).toEqual([]);
    expect(await cadenceTasks(ok.project.id)).toHaveLength(1);
  });

  it("the checklist is the template's steps with their owner, and the task's owner follows its steps", async () => {
    const step = (key: string, owner: OwnerTag, position: number): SopStep => ({
      key, phaseKey: "r", phaseTitle: "Run", position, title: `Do ${key}`, owner, estMinutes: 5, doneWhen: "", docTemplate: null, emailTemplate: null, requires: [], milestone: null, clientSummary: null, skippable: false,
    });
    const make = (key: string, owners: OwnerTag[]): SopTemplateInput => ({
      key, name: `Run ${key}`, kind: "recurring", cadence: "weekly", cadenceDay: 1, appliesTo: [], active: true, steps: owners.map((o, i) => step(`s${i}`, o, i + 1)),
    });
    await saveTemplate(env.DB, make("R-CLAUDE", ["claude", "claude"]));
    await saveTemplate(env.DB, make("R-DRAFTS", ["claude", "claude_drafts"]));
    await saveTemplate(env.DB, make("R-LOGAN", ["claude", "claude_drafts", "logan"]));
    const owners: Record<string, string> = {};
    for (const key of ["R-CLAUDE", "R-DRAFTS", "R-LOGAN"]) {
      const s = await withCadence(key);
      await generateRecurring(e, NOW);
      const [t] = await cadenceTasks(s.project.id);
      owners[key] = t.owner;
      if (key === "R-LOGAN") {
        expect(t.checklist).toEqual([{ text: `Do s0 (${OWNER_LABEL.claude})`, done: false }, { text: `Do s1 (${OWNER_LABEL.claude_drafts})`, done: false }, { text: `Do s2 (${OWNER_LABEL.logan})`, done: false }]);
        expect(t).toMatchObject({ title: "Run R-LOGAN: Week of Nov 16", dueOn: "2026-11-16", estMinutes: 15 });
      }
    }
    expect(owners).toEqual({ "R-CLAUDE": "claude", "R-DRAFTS": "claude_drafts", "R-LOGAN": "logan" });
  });

  it("the seeded Care weekly update is Logan's, because one of its steps is", async () => {
    const s = await withCadence("CARE-1");
    await generateRecurring(e, NOW);
    expect((await cadenceTasks(s.project.id))[0].owner).toBe("logan");
  });

  it("a second sweep running at the same moment adds nothing (the unique index holds)", async () => {
    const s = await withCadence("CARE-1");
    const [a, b] = await Promise.all([generateRecurring(e, NOW), generateRecurring(e, NOW)]);
    expect(a + b).toBe(1);
    expect(await cadenceTasks(s.project.id)).toHaveLength(1);
  });
});

describe("sweepProjects", () => {
  it("the sweep dispatches ready Claude steps and expires an old sent change order and stops a stale timer", async () => {
    const now = new Date("2026-12-10T12:00:00.000Z");
    const a = await seedProject({ bare: true });
    await insertTasks(env.DB, [newTask(a.project.id, a.businessId, { stepKey: "a", owner: "claude", title: "Claude step" })]);
    const o = await seedOrder();
    await sendOrder(o.co, { expiresAt: "2026-12-06T00:00:00.000Z" });
    const b = await seedProject({ bare: true });
    const [work] = await insertTasks(env.DB, [newTask(b.project.id, b.businessId, { stepKey: "w", owner: "logan", title: "Logan step" })]);
    await startTimer(e, work.id, new Date("2026-12-04T23:00:00.000Z"));
    const c = await withCadence("CARE-4");

    // Two Claude steps go out: the one made by hand, and the monthly report the sweep has just made (every step of it is Claude's or Claude drafting, so it is ready at once).
    expect(await sweepProjects(e, now)).toEqual({ started: 0, recurring: 1, dispatched: 2, expired: 1, stopped: 1 });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE kind = ?`).bind(SOP_STEP_KIND).first<{ n: number }>())!.n).toBe(2);
    expect((await env.DB.prepare(`SELECT status FROM change_orders WHERE id = ?`).bind(o.co.id).first<{ status: string }>())!.status).toBe("expired");
    expect((await listActivity(env.DB, o.businessId)).some((x) => x.kind === "change_order_void" && /expired/.test(x.detail ?? ""))).toBe(true);
    expect(await env.DB.prepare(`SELECT 1 FROM time_entries WHERE ended_at IS NULL`).first()).toBeNull();
    expect(await cadenceTasks(c.project.id)).toHaveLength(1);

    // A second sweep does nothing new.
    expect(await sweepProjects(e, now)).toEqual({ started: 0, recurring: 0, dispatched: 0, expired: 0, stopped: 0 });
  });

  it("the sweep heals a paid proposal that never got its project", async () => {
    // The healing itself is covered in depth by test/projects-start.test.ts; here only that the daily sweep runs it and counts it.
    const s = await seedDeal();
    const content = { ...proposal(), packages: [{ key: "quick_fix" as const, version: 1, name: "Quick Fix", priceLine: "$500", includes: [] }] };
    const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content });
    const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    await setPaid(env.DB, doc.id, "2026-12-03T09:00:00.000Z");
    expect(await sweepProjects(e, NOW)).toMatchObject({ started: 1 });
    expect((await env.DB.prepare(`SELECT template_key FROM projects WHERE business_id = ?`).bind(s.businessId).all<{ template_key: string }>()).results.map((r) => r.template_key)).toEqual(["QUICKFIX"]);
    expect((await sweepProjects(e, NOW)).started).toBe(0);
  });

  it("one failing part does not stop the others", async () => {
    const now = new Date("2026-12-10T12:00:00.000Z");
    const a = await seedProject({ bare: true });
    await insertTasks(env.DB, [newTask(a.project.id, a.businessId, { stepKey: "a", owner: "claude" })]);
    const o = await seedOrder();
    await sendOrder(o.co, { expiresAt: "2026-12-06T00:00:00.000Z" });
    await withCadence("CARE-1");
    const broken = { ...e, DB: new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => { if (/project_cadences/.test(sql)) throw new Error("cadences down"); return t.prepare(sql); };
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) } as Env;
    const r = await sweepProjects(broken, now);
    expect(r).toMatchObject({ recurring: 0, dispatched: 1, expired: 1 });
    expect(errors.mock.calls.some((c: unknown[]) => /recurring/.test(String(c[0])) && /cadences down/.test(String(c[1])))).toBe(true);
  });

  it("the sweep sends no mail and makes no approval", async () => {
    const smtp = vi.fn(async () => {});
    setMailDeps({ smtp });
    const before = async () => ({
      approvals: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first<{ n: number }>())!.n,
      messages: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n,
    });
    const a = await seedProject({ bare: true });
    await insertTasks(env.DB, [newTask(a.project.id, a.businessId, { stepKey: "a", owner: "claude" })]);
    const o = await seedOrder();
    await sendOrder(o.co, { expiresAt: "2026-12-06T00:00:00.000Z" });
    await withCadence("CARE-1");
    const was = await before();
    await sweepProjects(e, new Date("2026-12-10T12:00:00.000Z"));
    expect(smtp).not.toHaveBeenCalled();
    expect(await before()).toEqual(was);
  });
});

describe("the daily cron", () => {
  it("runs the project sweep after the onboarding sweep", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await withCadence("CARE-4");
    await runScheduled(e, DAILY_CRON, NOW);
    expect(await cadenceTasks(s.project.id)).toHaveLength(1);
    const names = log.mock.calls.map((c) => String(c[0]));
    expect(names.indexOf("project sweep")).toBeGreaterThan(names.indexOf("onboarding sweep"));
    expect(names.indexOf("onboarding sweep")).toBeGreaterThanOrEqual(0);
  });

  it("a project sweep that throws is logged and never fails the cron", async () => {
    const broken = { ...e, DB: new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => { if (/FROM project_cadences|JOIN projects p ON p.id = c.project_id/.test(sql)) throw new Error("db down"); return t.prepare(sql); };
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) } as Env;
    await expect(runScheduled(broken, DAILY_CRON, NOW)).resolves.toBeUndefined();
  });
});
