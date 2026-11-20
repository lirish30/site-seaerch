import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { setProjectStatus } from "../src/worker/db/projects";
import {
  addComment, deleteTask, getTask, insertTasks, listComments, listOpenTasksForLogan, listTasks, moveTask, patchTask, setTaskStatus, TaskInputError,
} from "../src/worker/db/tasks";
import { newTask, seedProject, seedSteps, T0, T1, T2 } from "./fixtures/projects";

const T3 = "2026-12-03T13:00:00.000Z";

describe("insertTasks and reads", () => {
  it("inserts every row in one batch and reads them back in position order", async () => {
    const s = await seedProject();
    const made = await insertTasks(env.DB, [
      newTask(s.project.id, s.businessId, { stepKey: "b", position: 1, title: "Second", requires: ["a"], milestone: "design_approved", clientSummary: "We are on it", docTemplate: "d1", emailTemplate: "e1", checklist: [{ text: "one", done: false }] }),
      newTask(s.project.id, s.businessId, { stepKey: "a", position: 0, title: "First", owner: "claude", estMinutes: 30, doneWhen: "it is done", skippable: true, billable: true, dueOn: "2026-12-10" }),
    ]);
    expect(made).toHaveLength(2);
    const list = await listTasks(env.DB, s.project.id);
    expect(list.map((t) => t.stepKey)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({
      id: made[1].id, projectId: s.project.id, businessId: s.businessId, isStep: true, phaseKey: "p1", phaseTitle: "Phase one", position: 0, title: "First", description: "", owner: "claude",
      status: "todo", doneWhen: "it is done", estMinutes: 30, dueOn: "2026-12-10", billable: true, skippable: true, requires: [], milestone: null, clientSummary: null, changeOrderId: null,
      cadenceKey: null, periodKey: null, claudeTaskId: null, reviewApprovalId: null, startedAt: null, doneAt: null,
    });
    expect(list[1]).toMatchObject({ requires: ["a"], milestone: "design_approved", clientSummary: "We are on it", docTemplate: "d1", emailTemplate: "e1", checklist: [{ text: "one", done: false }] });
    expect(list[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(made[0]).toEqual(list[1]);
    expect(await getTask(env.DB, list[0].id)).toEqual(list[0]);
    expect(await getTask(env.DB, "nope")).toBeNull();
    expect(await insertTasks(env.DB, [])).toEqual([]);
  });

  it("a step key is used once per project, and a failed batch inserts nothing", async () => {
    const s = await seedProject();
    await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await expect(insertTasks(env.DB, [
      newTask(s.project.id, s.businessId, { stepKey: "2", position: 1 }), newTask(s.project.id, s.businessId, { stepKey: "1", position: 2 }),
    ])).rejects.toThrow();
    expect((await listTasks(env.DB, s.project.id)).map((t) => t.stepKey)).toEqual(["1"]);
    // Tasks that are not steps carry no step key, and the same key in another project is fine.
    await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { isStep: false, position: 5 }), newTask(s.project.id, s.businessId, { isStep: false, position: 6 })]);
    const other = await seedProject();
    await seedSteps(other.project.id, other.businessId, [{ key: "1" }]);
    expect(await listTasks(env.DB, s.project.id)).toHaveLength(3);
  });

  it("defensive reads: bad requires and checklist JSON come back empty", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await env.DB.prepare(`UPDATE tasks SET requires = 'not json', checklist = '{"a":1}' WHERE id = ?`).bind(t.id).run();
    expect(await getTask(env.DB, t.id)).toMatchObject({ requires: [], checklist: [] });
  });
});

describe("setTaskStatus", () => {
  it("setTaskStatus with a from guard changes nothing when the status moved", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    expect(await setTaskStatus(env.DB, t.id, "in_progress", { from: ["todo"], now: T1 })).toBe(true);
    // Another caller got there first: the task is no longer todo, so this changes nothing.
    expect(await setTaskStatus(env.DB, t.id, "in_review", { from: ["todo"], now: T2 })).toBe(false);
    expect(await getTask(env.DB, t.id)).toMatchObject({ status: "in_progress", updatedAt: T1 });
    expect(await setTaskStatus(env.DB, t.id, "in_review", { from: ["todo", "in_progress"], now: T2 })).toBe(true);
    expect((await getTask(env.DB, t.id))!.status).toBe("in_review");
    // No guard: any status moves.
    expect(await setTaskStatus(env.DB, t.id, "waiting_client", { now: T3 })).toBe(true);
    expect(await setTaskStatus(env.DB, "nope", "done", { now: T3 })).toBe(false);
  });

  it("done stamps doneAt and the first in_progress stamps startedAt once", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await setTaskStatus(env.DB, t.id, "in_progress", { now: T1 });
    expect(await getTask(env.DB, t.id)).toMatchObject({ startedAt: T1, doneAt: null });
    await setTaskStatus(env.DB, t.id, "in_review", { now: T2 });
    await setTaskStatus(env.DB, t.id, "in_progress", { now: T3 });
    expect((await getTask(env.DB, t.id))!.startedAt).toBe(T1);
    await setTaskStatus(env.DB, t.id, "done", { now: T3 });
    expect(await getTask(env.DB, t.id)).toMatchObject({ status: "done", startedAt: T1, doneAt: T3, updatedAt: T3 });
    // Done again keeps the first stamp; a task that goes back to work has no doneAt.
    await setTaskStatus(env.DB, t.id, "done", { now: "2026-12-04T00:00:00.000Z" });
    expect((await getTask(env.DB, t.id))!.doneAt).toBe(T3);
    await setTaskStatus(env.DB, t.id, "todo", { now: "2026-12-04T00:00:00.000Z" });
    expect(await getTask(env.DB, t.id)).toMatchObject({ status: "todo", doneAt: null, startedAt: T1 });
  });

  it("claudeTaskId and reviewApprovalId are set, kept or cleared with the status", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await setTaskStatus(env.DB, t.id, "in_progress", { now: T1, claudeTaskId: "ct-1" });
    expect(await getTask(env.DB, t.id)).toMatchObject({ claudeTaskId: "ct-1", reviewApprovalId: null });
    await setTaskStatus(env.DB, t.id, "in_review", { now: T2, reviewApprovalId: "ap-1" });
    expect(await getTask(env.DB, t.id)).toMatchObject({ claudeTaskId: "ct-1", reviewApprovalId: "ap-1" });
    await setTaskStatus(env.DB, t.id, "todo", { now: T3, claudeTaskId: null, reviewApprovalId: null });
    expect(await getTask(env.DB, t.id)).toMatchObject({ claudeTaskId: null, reviewApprovalId: null });
  });

  it("an invalid status rejects", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await expect(setTaskStatus(env.DB, t.id, "bogus" as never, { now: T1 })).rejects.toThrow();
  });
});

describe("patchTask", () => {
  it("changes only the fields given and stamps updatedAt", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    const p = await patchTask(env.DB, t.id, {
      title: "  New title ", description: "More words", owner: "claude_drafts", doneWhen: "Looks right", estMinutes: 45, dueOn: "2026-12-24", billable: true, skippable: true,
      requires: ["0.1"], checklist: [{ text: "Call the client", done: true }], clientSummary: "We are on it",
    }, T1);
    expect(p).toMatchObject({
      title: "New title", description: "More words", owner: "claude_drafts", doneWhen: "Looks right", estMinutes: 45, dueOn: "2026-12-24", billable: true, skippable: true,
      requires: ["0.1"], checklist: [{ text: "Call the client", done: true }], clientSummary: "We are on it", updatedAt: T1, status: "todo", stepKey: "1",
    });
    const q = await patchTask(env.DB, t.id, { dueOn: null, clientSummary: null }, T2);
    expect(q).toMatchObject({ dueOn: null, clientSummary: null, title: "New title", estMinutes: 45, updatedAt: T2 });
    expect(await patchTask(env.DB, t.id, {}, T3)).toMatchObject({ title: "New title", updatedAt: T2 });
    await expect(patchTask(env.DB, "nope", { title: "x" }, T1)).rejects.toThrow();
  });

  it("strips control and bidi characters from the text it stores", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    const p = await patchTask(env.DB, t.id, { title: "Ti\u202Etle\u0007", description: "a\u200Bb", checklist: [{ text: "x\u202Ey", done: false }] }, T1);
    expect(p).toMatchObject({ title: "Title", description: "ab", checklist: [{ text: "xy", done: false }] });
  });

  it("refuses text over the caps and refuses a blank title, saving nothing", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    const bad: [Parameters<typeof patchTask>[2], RegExp][] = [
      [{ title: "x".repeat(121) }, /title is at most 120/i],
      [{ title: "  " }, /needs a title/i],
      [{ description: "x".repeat(2001) }, /description is at most 2000/i],
      [{ checklist: Array.from({ length: 41 }, () => ({ text: "a", done: false })) }, /at most 40/i],
      [{ checklist: [{ text: "x".repeat(201), done: false }] }, /at most 200/i],
      [{ owner: "someone" as never }, /owner/i],
      [{ estMinutes: -1 }, /estimate/i],
      [{ estMinutes: 1.5 }, /whole minutes/i],
      [{ dueOn: "2026-02-31" }, /date/i],
      [{ dueOn: "next week" }, /date/i],
      [{ clientSummary: "x".repeat(81) }, /at most 80/i],
    ];
    for (const [patch, msg] of bad) {
      const e = await patchTask(env.DB, t.id, { title: "Changed", ...patch }, T1).catch((x) => x);
      expect(e, JSON.stringify(patch)).toBeInstanceOf(TaskInputError);
      expect((e as Error).message).toMatch(msg);
    }
    expect(await getTask(env.DB, t.id)).toMatchObject({ title: "Step 1", updatedAt: t.updatedAt });
    // At the caps is fine.
    await patchTask(env.DB, t.id, { title: "x".repeat(120), description: "y".repeat(2000), checklist: Array.from({ length: 40 }, () => ({ text: "z".repeat(200), done: false })) }, T1);
  });
});

describe("moveTask", () => {
  it("moveTask renumbers without gaps", async () => {
    const s = await seedProject();
    const ts = await seedSteps(s.project.id, s.businessId, [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }]);
    const keys = async () => (await listTasks(env.DB, s.project.id)).map((t) => `${t.stepKey}${t.position}`);
    await moveTask(env.DB, ts[3].id, 1);
    expect(await keys()).toEqual(["a0", "d1", "b2", "c3"]);
    await moveTask(env.DB, ts[0].id, 3);
    expect(await keys()).toEqual(["d0", "b1", "c2", "a3"]);
    await moveTask(env.DB, ts[0].id, 99); // past the end clamps
    expect(await keys()).toEqual(["d0", "b1", "c2", "a3"]);
    await moveTask(env.DB, ts[2].id, -5); // before the start clamps
    expect(await keys()).toEqual(["c0", "d1", "b2", "a3"]);
  });

  it("closes gaps and ties left by earlier inserts, and leaves other projects alone", async () => {
    const s = await seedProject();
    const other = await seedProject();
    const o = await seedSteps(other.project.id, other.businessId, [{ key: "a" }, { key: "b" }]);
    const ts = await insertTasks(env.DB, ["a", "b", "c"].map((k, i) => newTask(s.project.id, s.businessId, { stepKey: k, position: i * 10 })));
    await moveTask(env.DB, ts[0].id, 1);
    expect((await listTasks(env.DB, s.project.id)).map((t) => `${t.stepKey}${t.position}`)).toEqual(["b0", "a1", "c2"]);
    expect((await listTasks(env.DB, other.project.id)).map((t) => t.position)).toEqual([0, 1]);
    expect(o).toHaveLength(2);
    await expect(moveTask(env.DB, "nope", 0)).rejects.toThrow();
  });
});

describe("deleteTask", () => {
  it("deletes a plain todo task, with its comments", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await addComment(env.DB, t.id, "logan", "a note", T1);
    expect(await deleteTask(env.DB, t.id)).toBe(true);
    expect(await getTask(env.DB, t.id)).toBeNull();
    expect(await listComments(env.DB, t.id)).toEqual([]);
    expect(await deleteTask(env.DB, t.id)).toBe(false);
  });

  it("deleteTask refuses a started task, a task with time, and a step another task requires", async () => {
    const s = await seedProject();
    const ts = await seedSteps(s.project.id, s.businessId, [{ key: "a" }, { key: "b", requires: ["a"] }, { key: "c" }, { key: "d" }, { key: "e" }]);
    const [a, b, c, d, e] = ts;
    // b requires a: a stays.
    expect(await deleteTask(env.DB, a.id)).toBe(false);
    expect(await getTask(env.DB, a.id)).not.toBeNull();
    // A task that was started and sent back to todo has a startedAt, so it stays.
    await setTaskStatus(env.DB, c.id, "in_progress", { now: T1 });
    await setTaskStatus(env.DB, c.id, "todo", { now: T2 });
    expect(await deleteTask(env.DB, c.id)).toBe(false);
    // A task with a time entry stays.
    await env.DB.prepare(
      `INSERT INTO time_entries (id, task_id, project_id, business_id, started_at, ended_at, minutes, source, created_at) VALUES ('te1', ?, ?, ?, ?, ?, 15, 'manual', ?)`,
    ).bind(d.id, s.project.id, s.businessId, T0, T1, T1).run();
    expect(await deleteTask(env.DB, d.id)).toBe(false);
    // Not todo: stays.
    await setTaskStatus(env.DB, e.id, "done", { now: T1 });
    expect(await deleteTask(env.DB, e.id)).toBe(false);
    // b is a plain todo nobody requires: it goes, and then a is free to go too.
    expect(await deleteTask(env.DB, b.id)).toBe(true);
    expect(await deleteTask(env.DB, a.id)).toBe(true);
    expect((await listTasks(env.DB, s.project.id)).map((t) => t.stepKey)).toEqual(["c", "d", "e"]);
  });

  it("another project's requires does not hold a step, and a malformed requires is ignored", async () => {
    const s = await seedProject();
    const other = await seedProject();
    const [a] = await seedSteps(s.project.id, s.businessId, [{ key: "a" }]);
    await seedSteps(other.project.id, other.businessId, [{ key: "z", requires: ["a"] }]);
    const [g] = await seedSteps(s.project.id, s.businessId, [{ key: "g" }]);
    await env.DB.prepare(`UPDATE tasks SET requires = 'garbage' WHERE id = ?`).bind(g.id).run();
    expect(await deleteTask(env.DB, a.id)).toBe(true);
  });
});

describe("comments", () => {
  it("a comment is stored as capped text with control and bidi characters removed", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await addComment(env.DB, t.id, "claude", "  Done\u202E reading\u0000 it  ", T1);
    await addComment(env.DB, t.id, "system", "x".repeat(5000), T2);
    await addComment(env.DB, t.id, "logan", "mine", T3);
    const list = await listComments(env.DB, t.id);
    expect(list.map((c) => c.author)).toEqual(["claude", "system", "logan"]);
    expect(list[0]).toMatchObject({ body: "Done reading it", createdAt: T1 });
    expect(list[0].id).toBeTruthy();
    expect(list[1].body).toHaveLength(4000);
    expect(await listComments(env.DB, "nope")).toEqual([]);
  });

  it("refuses an empty comment and a comment that reads like a login", async () => {
    const s = await seedProject();
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1" }]);
    await expect(addComment(env.DB, t.id, "logan", " \u202E ", T1)).rejects.toBeInstanceOf(TaskInputError);
    await expect(addComment(env.DB, t.id, "claude", "the password: hunter2", T1)).rejects.toThrow(/login or password/i);
    await expect(addComment(env.DB, t.id, "logan", "api key = abc", T1)).rejects.toBeInstanceOf(TaskInputError);
    expect(await listComments(env.DB, t.id)).toEqual([]);
  });
});

describe("listOpenTasksForLogan", () => {
  it("lists Logan's open tasks and Claude's drafts waiting for him, from active projects, with names", async () => {
    const a = await seedProject({ name: "Alpha" });
    const b = await seedProject({ name: "Beta" });
    const ts = await seedSteps(a.project.id, a.businessId, [
      { key: "l-todo", owner: "logan" }, { key: "l-prog", owner: "logan" }, { key: "l-done", owner: "logan" }, { key: "c-todo", owner: "claude" },
      { key: "d-todo", owner: "claude_drafts" }, { key: "d-review", owner: "claude_drafts" }, { key: "l-wait", owner: "logan" }, { key: "l-skip", owner: "logan" },
    ]);
    const by = (k: string) => ts.find((t) => t.stepKey === k)!;
    await setTaskStatus(env.DB, by("l-prog").id, "in_progress", { now: T1 });
    await setTaskStatus(env.DB, by("l-done").id, "done", { now: T1 });
    await setTaskStatus(env.DB, by("d-review").id, "in_review", { now: T1 });
    await setTaskStatus(env.DB, by("l-wait").id, "waiting_client", { now: T1 });
    await setTaskStatus(env.DB, by("l-skip").id, "skipped", { now: T1 });
    await patchTask(env.DB, by("l-todo").id, { dueOn: "2026-12-05" }, T1);
    const [bt] = await seedSteps(b.project.id, b.businessId, [{ key: "paused-one", owner: "logan" }]);
    await setProjectStatus(env.DB, b.project.id, "paused", { reason: "x", now: T1 });

    const list = (await listOpenTasksForLogan(env.DB)).filter((t) => t.projectId === a.project.id || t.projectId === b.project.id);
    expect(list.map((t) => t.stepKey)).toEqual(["l-todo", "l-prog", "d-review"]);
    expect(list[0]).toMatchObject({ projectName: "Alpha", dueOn: "2026-12-05" });
    expect(list[0].businessName).toBeTruthy();
    expect(list.some((t) => t.id === bt.id)).toBe(false);
  });
});
