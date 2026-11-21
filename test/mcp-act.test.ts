import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays, calendarDateIn } from "../src/worker/billing/dates";
import { listActivity } from "../src/worker/db/activity";
import { setProjectStatus } from "../src/worker/db/projects";
import { saveSettings, getSettings } from "../src/worker/db/settings";
import { listComments, listTasks, setTaskStatus } from "../src/worker/db/tasks";
import { listEntriesForTask } from "../src/worker/db/time";
import { recordUsage } from "../src/worker/db/usage";
import { zoneOf } from "../src/worker/sop/cadence";
import { seedBusiness } from "./fixtures/cro";
import { mcp, actionCount, ok, tool } from "./fixtures/mcp";
import { resetProjectWork, seedProject, seedSteps } from "./fixtures/projects";

const created: any[] = [];
let orig: typeof env.LEAD_WORKFLOW.create;
beforeEach(async () => {
  await resetProjectWork();
  await env.DB.prepare(`UPDATE fixed_costs SET active = 0`).run(); // these tests budget metered usage only
  await env.DB.prepare(`DELETE FROM usage`).run();
  await saveSettings(env.DB, { monthly_spend_limit_usd: 25 });
  created.length = 0;
  orig = env.LEAD_WORKFLOW.create;
  (env.LEAD_WORKFLOW as any).create = async (o: any) => { created.push(o); return { id: o.id }; };
});
afterEach(async () => {
  (env.LEAD_WORKFLOW as any).create = orig;
  await env.DB.prepare(`DELETE FROM usage`).run();
});

/** Every act tool must write exactly one row per call, whether it worked or was refused. */
async function oneAction(name: string, args: unknown) {
  const before = await actionCount(name);
  const r = await tool(name, args);
  expect(await actionCount(name)).toBe(before + 1);
  return r;
}
const activityOf = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === kind);
const CREDENTIAL = "password: hunter2-secret";

describe("the tool registry", () => {
  const ALLOWED = [
    // the original eight
    "search_leads", "get_lead", "list_approvals", "propose_approval", "next_claude_task", "complete_claude_task", "release_claude_task", "queue_status",
    // the eleven read tools
    "search_clients", "get_client", "get_site", "list_projects", "get_project", "list_open_tasks", "get_deal", "get_timeline", "list_invoices", "list_meetings", "get_meeting",
    // the five act tools
    "run_audit", "log_time", "add_task", "add_task_comment", "add_note",
    // the money summary
    "get_money_summary",
    // the three care tools
    "get_care_overview", "get_care_updates", "list_incidents",
  ];
  const registered = async (): Promise<string[]> => (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);

  it("registers only the tools on the allow-list, and every required one", async () => {
    const names = await registered();
    for (const n of names) expect(ALLOWED, `unexpected tool ${n}`).toContain(n);
    for (const n of ALLOWED) expect(names, `missing tool ${n}`).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has no tool that approves, rejects, sends, executes or deletes", async () => {
    for (const n of await registered()) expect(n).not.toMatch(/approve|reject|send|execute|delete/);
  });
});

describe("run_audit", () => {
  it("starts one full-stage workflow for a real lead and logs the reaudit line and one action", async () => {
    const b = await seedBusiness();
    const r = await oneAction("run_audit", { business_id: b.id });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0].params).toEqual({ businessId: b.id, searchId: null, forceDraft: false, stage: "full" });
    expect(created[0].id).toMatch(new RegExp(`^fullscan-${b.id}-`));
    expect(await activityOf(b.id, "reaudit")).toHaveLength(1);
  });

  it("refuses an unknown id with the route's wording and starts nothing", async () => {
    const r = await oneAction("run_audit", { business_id: "nope" });
    expect(r).toEqual({ isError: true, text: "not found" });
    expect(created).toHaveLength(0);
  });

  it("refuses at the spend cap with the route's wording, starts nothing and logs no activity", async () => {
    const b = await seedBusiness();
    await recordUsage(env.DB, "claude", 1, 24.9999);
    const r = await oneAction("run_audit", { business_id: b.id });
    expect(r).toEqual({ isError: true, text: "spend limit" });
    expect(created).toHaveLength(0);
    expect(await activityOf(b.id, "reaudit")).toHaveLength(0);
  });

  it("answers with the workflow's own message when it cannot start, and writes no activity", async () => {
    const b = await seedBusiness();
    (env.LEAD_WORKFLOW as any).create = async () => { throw new Error("workflow unavailable"); };
    const r = await oneAction("run_audit", { business_id: b.id });
    expect(r).toEqual({ isError: true, text: "workflow unavailable" });
    expect(await activityOf(b.id, "reaudit")).toHaveLength(0);
  });
});

describe("log_time", () => {
  async function seedTask() {
    const s = await seedProject();
    const [task] = await seedSteps(s.project.id, s.businessId, [{ key: "a" }]);
    return { ...s, task };
  }
  const today = async () => calendarDateIn(new Date(), zoneOf(await getSettings(env.DB)));

  it("adds a manual entry for yesterday", async () => {
    const s = await seedTask();
    const yesterday = addDays(await today(), -1);
    const r = await oneAction("log_time", { task_id: s.task.id, minutes: 45, day: yesterday, note: "Fixed the header", billable: true });
    expect(r.isError).toBe(false);
    const [entry] = await listEntriesForTask(env.DB, s.task.id);
    expect(entry).toMatchObject({ minutes: 45, billable: true, note: "Fixed the header", source: "manual" });
    expect(JSON.parse(r.text)).toMatchObject({ id: entry.id, minutes: 45 });
  });

  it("defaults the day to today in the booking zone", async () => {
    const s = await seedTask();
    await ok("log_time", { task_id: s.task.id, minutes: 10 });
    const [entry] = await listEntriesForTask(env.DB, s.task.id);
    const zone = zoneOf(await getSettings(env.DB));
    // The entry sits at noon of its day in the zone, so it falls on today there (a run across midnight in the zone could differ by a day).
    expect([await today(), addDays(await today(), -1)]).toContain(calendarDateIn(new Date(entry.startedAt), zone));
  });

  it("refuses a future day", async () => {
    const s = await seedTask();
    const r = await oneAction("log_time", { task_id: s.task.id, minutes: 30, day: addDays(await today(), 2) });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Time cannot be logged on a day that has not come yet.");
    expect(await listEntriesForTask(env.DB, s.task.id)).toHaveLength(0);
  });

  it("refuses a locked task", async () => {
    const s = await seedTask();
    await setTaskStatus(env.DB, s.task.id, "locked", { now: "2026-12-03T10:00:00.000Z" });
    const r = await oneAction("log_time", { task_id: s.task.id, minutes: 30 });
    expect(r).toEqual({ isError: true, text: "A locked task cannot take time yet." });
  });

  it("refuses 0 and 1441 minutes, and logs an action each time", async () => {
    const s = await seedTask();
    for (const minutes of [0, 1441]) {
      const r = await oneAction("log_time", { task_id: s.task.id, minutes });
      expect(r).toEqual({ isError: true, text: "Minutes must be a whole number from 1 to 1440." });
    }
    expect(await listEntriesForTask(env.DB, s.task.id)).toHaveLength(0);
  });

  it("refuses an unknown task and a day that is not a date", async () => {
    const s = await seedTask();
    expect((await oneAction("log_time", { task_id: "nope", minutes: 5 })).text).toBe("There is no such task.");
    expect((await oneAction("log_time", { task_id: s.task.id, minutes: 5, day: "2026-02-30" })).isError).toBe(true);
  });

  it("refuses a note that looks like a login without echoing it", async () => {
    const s = await seedTask();
    const r = await oneAction("log_time", { task_id: s.task.id, minutes: 5, note: CREDENTIAL });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("hunter2");
    expect(await listEntriesForTask(env.DB, s.task.id)).toHaveLength(0);
  });
});

describe("add_task", () => {
  it("adds an ad hoc to-do for Logan that is not a step and never reaches the Claude queue", async () => {
    const s = await seedProject();
    const queued = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks`).first<{ n: number }>())!.n;
    const before = await queued();
    const r = await oneAction("add_task", { project_id: s.project.id, title: "Check the contact form", owner: "logan", est_minutes: 20, due_on: "2026-12-24" });
    expect(r.isError).toBe(false);
    const [task] = (await listTasks(env.DB, s.project.id)).filter((t) => t.title === "Check the contact form");
    expect(task).toMatchObject({ isStep: false, owner: "logan", estMinutes: 20, dueOn: "2026-12-24", status: "todo", claudeTaskId: null });
    expect(JSON.parse(r.text)).toMatchObject({ id: task.id, title: "Check the contact form", owner: "logan", status: "todo" });
    expect(await queued()).toBe(before);
  });

  it("owner is optional and defaults to logan", async () => {
    const s = await seedProject();
    await ok("add_task", { project_id: s.project.id, title: "No owner given" });
    expect((await listTasks(env.DB, s.project.id)).find((t) => t.title === "No owner given")).toMatchObject({ owner: "logan", claudeTaskId: null });
  });

  it("refuses owner claude and claude_drafts, and anything else, creating no task and queueing nothing", async () => {
    const s = await seedProject();
    const before = (await listTasks(env.DB, s.project.id)).length;
    const queued = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks`).first<{ n: number }>())!.n;
    const queuedBefore = await queued();
    for (const owner of ["claude", "claude_drafts", "client", "nobody"]) {
      const r = await oneAction("add_task", { project_id: s.project.id, title: "Injected work", owner });
      expect(r).toEqual({ isError: true, text: "add_task only adds to-dos for Logan. Logan assigns Claude work in the app." });
    }
    expect((await listTasks(env.DB, s.project.id)).length).toBe(before);
    expect(await queued()).toBe(queuedBefore);
  });

  it("refuses a cancelled project", async () => {
    const s = await seedProject();
    await setProjectStatus(env.DB, s.project.id, "cancelled");
    const r = await oneAction("add_task", { project_id: s.project.id, title: "Too late", owner: "logan" });
    expect(r).toEqual({ isError: true, text: "A cancelled project cannot take new tasks." });
  });

  it("refuses an unknown project, a bad due date and a blank title", async () => {
    const s = await seedProject();
    expect((await oneAction("add_task", { project_id: "nope", title: "x", owner: "logan" })).text).toBe("There is no such project.");
    expect((await oneAction("add_task", { project_id: s.project.id, title: "x", owner: "logan", due_on: "2026-02-30" })).isError).toBe(true);
    expect((await oneAction("add_task", { project_id: s.project.id, title: "   ", owner: "logan" })).isError).toBe(true);
  });

  it("refuses a title that looks like a login without echoing it, and adds nothing", async () => {
    const s = await seedProject();
    const before = (await listTasks(env.DB, s.project.id)).length;
    const r = await oneAction("add_task", { project_id: s.project.id, title: CREDENTIAL, owner: "logan" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("hunter2");
    expect((await listTasks(env.DB, s.project.id)).length).toBe(before);
    const rows = await env.DB.prepare(`SELECT summary FROM agent_actions WHERE tool = 'add_task'`).all<{ summary: string }>();
    for (const row of rows.results) expect(row.summary).not.toContain("hunter2");
  });
});

describe("add_task_comment", () => {
  it("adds a comment authored claude", async () => {
    const s = await seedProject();
    const [task] = await seedSteps(s.project.id, s.businessId, [{ key: "a" }]);
    const r = await oneAction("add_task_comment", { task_id: task.id, body: "Waiting on the logo files." });
    expect(r.isError).toBe(false);
    expect(await listComments(env.DB, task.id)).toMatchObject([{ author: "claude", body: "Waiting on the logo files." }]);
  });

  it("refuses an unknown task, an empty body and a credential, never echoing it", async () => {
    const s = await seedProject();
    const [task] = await seedSteps(s.project.id, s.businessId, [{ key: "a" }]);
    expect((await oneAction("add_task_comment", { task_id: "nope", body: "hi" })).text).toBe("There is no such task.");
    expect((await oneAction("add_task_comment", { task_id: task.id, body: "  " })).isError).toBe(true);
    const r = await oneAction("add_task_comment", { task_id: task.id, body: CREDENTIAL });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("hunter2");
    expect(await listComments(env.DB, task.id)).toHaveLength(0);
    const rows = await env.DB.prepare(`SELECT summary FROM agent_actions WHERE tool = 'add_task_comment'`).all<{ summary: string }>();
    for (const row of rows.results) expect(row.summary).not.toContain("hunter2");
  });
});

describe("add_note", () => {
  it("writes one note activity line", async () => {
    const b = await seedBusiness();
    const r = await oneAction("add_note", { business_id: b.id, text: "Owner prefers texts after 4pm." });
    expect(r.isError).toBe(false);
    expect(await activityOf(b.id, "note")).toMatchObject([{ detail: "Owner prefers texts after 4pm." }]);
  });

  it("refuses an unknown business, an empty note, a long note and a credential, writing nothing", async () => {
    const b = await seedBusiness();
    expect((await oneAction("add_note", { business_id: "nope", text: "hi" })).text).toBe("business not found: nope");
    expect((await oneAction("add_note", { business_id: b.id, text: "   " })).isError).toBe(true);
    expect((await tool("add_note", { business_id: b.id, text: "x".repeat(501) })).isError).toBe(true);
    const r = await oneAction("add_note", { business_id: b.id, text: CREDENTIAL });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("hunter2");
    expect(await activityOf(b.id, "note")).toHaveLength(0);
    const rows = await env.DB.prepare(`SELECT summary FROM agent_actions WHERE tool = 'add_note'`).all<{ summary: string }>();
    for (const row of rows.results) expect(row.summary).not.toContain("hunter2");
  });
});
