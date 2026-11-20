import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { ensureSeedSops, getTemplate } from "../src/worker/db/sops";
import { getProject, listCadences, listMilestones, markProjectDone } from "../src/worker/db/projects";
import { getTask, insertTasks, listComments, listTasks, setTaskStatus, TaskInputError, type NewTask, type Task } from "../src/worker/db/tasks";
import { listEntriesForTask, runningEntry } from "../src/worker/db/time";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onMilestone, onProjectDone, onTasksChanged } from "../src/worker/projects/hooks";
import {
  addAdhocTask, completeTask, postComment, projectIsFinished, reopenTask, setWaitingClient, skipTask, startTask, TaskBlockedError, TaskStateError, updateTask,
} from "../src/worker/projects/service";
import { instantiateSop } from "../src/worker/sop/instantiate";
import { startTimer } from "../src/worker/time/service";
import { newTask, seedProject, T0, T1, T2 } from "./fixtures/projects";

const e = env as Env;
const NOW = new Date(T1);
const by = "logan" as const;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

interface Spec { key: string; requires?: string[]; skippable?: boolean; milestone?: NewTask["milestone"]; owner?: Task["owner"]; title?: string; status?: Task["status"] }

/** A hand-made project (or a Care one) with step tasks keyed as given, in the order given. */
async function setup(specs: Spec[], o: { kind?: "care_onboarding" | "build"; test?: boolean } = {}) {
  const care = o.kind === "care_onboarding";
  const s = await seedProject({ bare: true, kind: o.kind, templateKey: care ? "CARE-0" : null, name: care ? "Care onboarding" : "Website build", test: o.test });
  const tasks = await insertTasks(env.DB, specs.map((x, i) => newTask(s.project.id, s.businessId, {
    stepKey: x.key, position: i, title: x.title ?? `Step ${x.key}`, requires: x.requires ?? [], skippable: x.skippable ?? false, milestone: x.milestone ?? null, owner: x.owner ?? "logan",
    status: x.status ?? "todo",
  })));
  const t = (key: string) => tasks.find((x) => x.stepKey === key)!;
  return { ...s, tasks, t };
}
const kinds = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const status = async (id: string) => (await getTask(env.DB, id))!.status;
const blockedBy = async (p: Promise<unknown>) => { try { await p; } catch (x) { if (x instanceof TaskBlockedError) return x.blockedBy; throw x; } throw new Error("did not throw"); };

describe("projectIsFinished", () => {
  const mk = (isStep: boolean, status: Task["status"]) => ({ isStep, status }) as Task;
  it("is true when every step is done or skipped and there is at least one", () => {
    expect(projectIsFinished([mk(true, "done"), mk(true, "skipped")])).toBe(true);
    expect(projectIsFinished([mk(true, "done"), mk(true, "todo")])).toBe(false);
    expect(projectIsFinished([mk(true, "done"), mk(true, "locked")])).toBe(false);
    expect(projectIsFinished([])).toBe(false);
  });
  it("ignores tasks that are not steps", () => {
    expect(projectIsFinished([mk(true, "done"), mk(false, "todo"), mk(false, "locked")])).toBe(true);
    expect(projectIsFinished([mk(false, "done")])).toBe(false);
  });
});

describe("startTask", () => {
  it("moves todo, waiting_client and in_review to in_progress and stamps startedAt once", async () => {
    const s = await setup([{ key: "a" }, { key: "b", status: "waiting_client" }, { key: "c", status: "in_review" }]);
    const a = await startTask(e, s.t("a").id, NOW);
    expect(a).toMatchObject({ status: "in_progress", startedAt: T1 });
    expect((await startTask(e, s.t("b").id, NOW)).status).toBe("in_progress");
    expect((await startTask(e, s.t("c").id, NOW)).status).toBe("in_progress");
    // a task already under way is returned as it is
    expect(await startTask(e, s.t("a").id, new Date(T2))).toMatchObject({ status: "in_progress", startedAt: T1 });
  });

  it("refuses done, skipped and locked tasks and a missing one", async () => {
    const s = await setup([{ key: "a", status: "done" }, { key: "b", status: "skipped" }, { key: "c", status: "locked" }]);
    for (const k of ["a", "b", "c"]) await expect(startTask(e, s.t(k).id, NOW)).rejects.toThrow(TaskStateError);
    expect(await status(s.t("c").id)).toBe("locked");
    await expect(startTask(e, "nope", NOW)).rejects.toThrow(/no such task/i);
  });

  it("refuses a task whose requirements are open and names them", async () => {
    const s = await setup([{ key: "a", title: "Do the first thing" }, { key: "b", requires: ["a"] }]);
    expect(await blockedBy(startTask(e, s.t("b").id, NOW))).toEqual(["Do the first thing"]);
    expect(await status(s.t("b").id)).toBe("todo");
  });
});

describe("completeTask gates", () => {
  it("complete refuses while a required step is open and names it in blockedBy", async () => {
    const s = await setup([{ key: "a", title: "Get the logo" }, { key: "b", title: "Get the photos" }, { key: "c", requires: ["a", "b"] }]);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    const err = await completeTask(e, s.t("c").id, { by, now: NOW }).catch((x) => x);
    expect(err).toBeInstanceOf(TaskBlockedError);
    expect(err).toBeInstanceOf(TaskStateError);
    expect(err.blockedBy).toEqual(["Get the photos"]);
    expect(err.message).toMatch(/Get the photos/);
    expect(await status(s.t("c").id)).toBe("todo");
    await completeTask(e, s.t("b").id, { by, now: NOW });
    expect((await completeTask(e, s.t("c").id, { by, now: NOW })).status).toBe("done");
  });

  it("a skipped skippable step satisfies requires but a skipped non-skippable one does not", async () => {
    const s = await setup([{ key: "a", skippable: true }, { key: "b", title: "Cannot skip me" }, { key: "c", requires: ["a"] }, { key: "d", requires: ["b"] }]);
    await skipTask(e, s.t("a").id, "The client has no use for it", NOW);
    await skipTask(e, s.t("b").id, "Trying to skip it anyway", NOW);
    expect((await completeTask(e, s.t("c").id, { by, now: NOW })).status).toBe("done");
    expect(await blockedBy(completeTask(e, s.t("d").id, { by, now: NOW }))).toEqual(["Cannot skip me"]);
  });

  it("go live stays blocked until every QA step, the backup and the client OK are done", async () => {
    await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
    await ensureSeedSops(env.DB);
    const template = (await getTemplate(env.DB, "BUILD"))!;
    const s = await seedProject();
    const tasks = await instantiateSop(env.DB, { project: s.project, template });
    const live = tasks.find((t) => t.stepKey === "7.4")!;
    const needs = live.requires;
    expect(needs).toEqual(expect.arrayContaining(["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9", "7.2"]));
    const byKey = (k: string) => tasks.find((t) => t.stepKey === k)!;
    for (const open of needs) {
      for (const k of needs) await setTaskStatus(env.DB, byKey(k).id, k === open ? "todo" : "done", { now: T0 });
      expect(await blockedBy(completeTask(e, live.id, { by, now: NOW })), open).toEqual([byKey(open).title]);
      expect(await status(live.id)).toBe("todo");
    }
    for (const k of needs) await setTaskStatus(env.DB, byKey(k).id, "done", { now: T0 });
    expect((await completeTask(e, live.id, { by, now: NOW })).status).toBe("done");
  });

  it("a locked task cannot start or complete", async () => {
    const s = await setup([{ key: "a", status: "locked" }]);
    await expect(startTask(e, s.t("a").id, NOW)).rejects.toThrow(TaskStateError);
    await expect(completeTask(e, s.t("a").id, { by, now: NOW })).rejects.toThrow(/locked/i);
    expect(await status(s.t("a").id)).toBe("locked");
  });

  it("a skipped step cannot be completed until it is reopened, and a missing task is refused", async () => {
    const s = await setup([{ key: "a", skippable: true }]);
    await skipTask(e, s.t("a").id, "Not needed here", NOW);
    await expect(completeTask(e, s.t("a").id, { by, now: NOW })).rejects.toThrow(TaskStateError);
    await expect(completeTask(e, "nope", { by, now: NOW })).rejects.toThrow(/no such task/i);
  });

  it("completing stops that task's running timer, and only that task's", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }]);
    await startTimer(e, s.t("a").id, new Date(T0));
    await completeTask(e, s.t("b").id, { by, now: new Date("2026-12-03T10:20:00.000Z") });
    expect(await runningEntry(env.DB)).not.toBeNull(); // b had no timer: a's keeps running
    const done = await completeTask(e, s.t("a").id, { by, now: new Date("2026-12-03T10:30:00.000Z") });
    expect(done).toMatchObject({ status: "done", doneAt: "2026-12-03T10:30:00.000Z" });
    expect(await runningEntry(env.DB)).toBeNull();
    expect((await listEntriesForTask(env.DB, s.t("a").id)).map((x) => x.minutes)).toEqual([30]);
  });
});

describe("milestones", () => {
  it("the milestone step reaches the milestone once, logs once and runs the milestone hook once on a replay", async () => {
    const s = await setup([{ key: "a", milestone: "design_approved" }, { key: "b" }]);
    const hook = vi.fn(async () => {});
    onMilestone(hook);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]).toMatchObject([e, { id: s.project.id }, "design_approved"]);
    expect(await listMilestones(env.DB, s.project.id)).toEqual([{ milestone: "design_approved", reachedAt: T1 }]);
    expect(await kinds(s.businessId, "project_milestone")).toHaveLength(1);
    // replay: the same request again, and a reopen followed by a second completion
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await reopenTask(e, s.t("a").id, NOW);
    await completeTask(e, s.t("a").id, { by, now: new Date(T2) });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_milestone")).toHaveLength(1);
    expect((await listMilestones(env.DB, s.project.id))[0].reachedAt).toBe(T1);
  });

  it("reopening a milestone step does not un-reach the milestone", async () => {
    const s = await setup([{ key: "a", milestone: "site_finished" }, { key: "b" }]);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    const reopened = await reopenTask(e, s.t("a").id, new Date(T2));
    expect(reopened).toMatchObject({ status: "todo", doneAt: null });
    expect((await listMilestones(env.DB, s.project.id)).map((m) => m.milestone)).toEqual(["site_finished"]);
  });

  it("a milestone hook that throws is logged and the task stays done", async () => {
    const s = await setup([{ key: "a", milestone: "design_approved" }, { key: "b" }]);
    onMilestone(async () => { throw new Error("invoice failed"); });
    const done = await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(done.status).toBe("done");
    expect(errors).toHaveBeenCalled();
    expect(await listMilestones(env.DB, s.project.id)).toHaveLength(1);
  });
});

describe("finishing the project", () => {
  it("completing the last step finishes the project once, logs project_done and runs the done hooks once", async () => {
    const s = await setup([{ key: "a" }, { key: "b", requires: ["a"] }]);
    const done = vi.fn(async () => {});
    const changed = vi.fn(async () => {});
    onProjectDone(done);
    onTasksChanged(changed);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(done).not.toHaveBeenCalled();
    expect((await getProject(env.DB, s.project.id))!.status).toBe("active");
    await completeTask(e, s.t("b").id, { by, now: new Date(T2) });
    expect(await getProject(env.DB, s.project.id)).toMatchObject({ status: "done", completedAt: T2 });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]).toMatchObject([e, { id: s.project.id, status: "done" }]);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith(e, s.project.id);
    // a replay of the last request changes nothing
    await completeTask(e, s.t("b").id, { by, now: new Date("2026-12-03T13:00:00.000Z") });
    expect(done).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
    expect((await getProject(env.DB, s.project.id))!.completedAt).toBe(T2);
  });

  it("two requests completing the last step at once finish the project once", async () => {
    const s = await setup([{ key: "a" }]);
    const done = vi.fn(async () => {});
    onProjectDone(done);
    const r = await Promise.all([completeTask(e, s.t("a").id, { by, now: NOW }), completeTask(e, s.t("a").id, { by: "claude", now: NOW })]);
    expect(r.map((t) => t.status)).toEqual(["done", "done"]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("the last two steps completed at the same moment still finish the project once", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }]);
    const done = vi.fn(async () => {});
    onProjectDone(done);
    await Promise.all([completeTask(e, s.t("a").id, { by, now: NOW }), completeTask(e, s.t("b").id, { by, now: NOW })]);
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    expect(done).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("skipping the last open step finishes the project too", async () => {
    const s = await setup([{ key: "a" }, { key: "b", skippable: true }]);
    const done = vi.fn(async () => {});
    onProjectDone(done);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await skipTask(e, s.t("b").id, "Client declined the extra", NOW);
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    expect(done).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("a care_onboarding project gets the CARE-1 and CARE-4 cadences when it finishes, and a build one does not", async () => {
    const care = await setup([{ key: "a" }], { kind: "care_onboarding" });
    await completeTask(e, care.t("a").id, { by, now: NOW });
    const mine = (await listCadences(env.DB)).filter((c) => c.projectId === care.project.id);
    expect(mine.map((c) => c.templateKey).sort()).toEqual(["CARE-1", "CARE-4"]);
    const build = await setup([{ key: "a" }], { kind: "build" });
    await completeTask(e, build.t("a").id, { by, now: NOW });
    expect((await listCadences(env.DB)).filter((c) => c.projectId === build.project.id)).toEqual([]);
  });

  it("a done hook that throws leaves the project done and is logged", async () => {
    const s = await setup([{ key: "a" }]);
    const second = vi.fn(async () => {});
    onProjectDone(async () => { throw new Error("care project failed"); });
    onProjectDone(second);
    const done = await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(done.status).toBe("done");
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    expect(second).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls.map((c: unknown[]) => c.join(" ")))).toMatch(/care project failed/);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("an ad-hoc task never finishes the project", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }]);
    const done = vi.fn(async () => {});
    onProjectDone(done);
    const extra = await addAdhocTask(e, { projectId: s.project.id, title: "Call the printer", owner: "logan" }, NOW);
    expect(extra).toMatchObject({ isStep: false, stepKey: null, status: "todo", title: "Call the printer", owner: "logan", billable: false, estMinutes: 0 });
    await completeTask(e, extra.id, { by, now: NOW });
    expect((await getProject(env.DB, s.project.id))!.status).toBe("active");
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await completeTask(e, s.t("b").id, { by, now: NOW });
    expect(done).toHaveBeenCalledTimes(1);
    // work added after the project finished does not reopen it, and finishing it does not run the hooks again
    const late = await addAdhocTask(e, { projectId: s.project.id, title: "One more thing", owner: "claude" }, NOW);
    await completeTask(e, late.id, { by, now: NOW });
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a finished project is not reopened by reopening a step", async () => {
    const s = await setup([{ key: "a" }]);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect((await reopenTask(e, s.t("a").id, new Date(T2))).status).toBe("todo");
    expect(await getProject(env.DB, s.project.id)).toMatchObject({ status: "done", completedAt: T1 });
    // finishing the step again does not finish the project a second time
    const done = vi.fn(async () => {});
    onProjectDone(done);
    await completeTask(e, s.t("a").id, { by, now: new Date("2026-12-03T13:00:00.000Z") });
    expect(done).not.toHaveBeenCalled();
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("completing a done task fires nothing", async () => {
    const s = await setup([{ key: "a", milestone: "design_approved" }, { key: "b" }]);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    const m = vi.fn(async () => {});
    const d = vi.fn(async () => {});
    const c = vi.fn(async () => {});
    onMilestone(m); onProjectDone(d); onTasksChanged(c);
    const again = await completeTask(e, s.t("a").id, { by, now: new Date(T2) });
    expect(again).toMatchObject({ status: "done", doneAt: T1 });
    expect(m).not.toHaveBeenCalled();
    expect(d).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
  });
});

describe("skipTask, reopenTask, setWaitingClient", () => {
  it("skip stores the reason as a system comment, stops the timer and runs the tasks-changed hook", async () => {
    const s = await setup([{ key: "a", skippable: true }, { key: "b" }]);
    const c = vi.fn(async () => {});
    onTasksChanged(c);
    await startTimer(e, s.t("a").id, new Date(T0));
    const t = await skipTask(e, s.t("a").id, "  The client said no  ", new Date("2026-12-03T10:15:00.000Z"));
    expect(t.status).toBe("skipped");
    expect(await runningEntry(env.DB)).toBeNull();
    expect(await listComments(env.DB, s.t("a").id)).toMatchObject([{ author: "system", body: expect.stringContaining("The client said no") }]);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("skip refuses a reason under 3 or over 300 characters, a credential, a done or locked task, and changes nothing", async () => {
    const s = await setup([{ key: "a" }, { key: "b", status: "done" }, { key: "c", status: "locked" }]);
    await expect(skipTask(e, s.t("a").id, "no", NOW)).rejects.toThrow(TaskInputError);
    await expect(skipTask(e, s.t("a").id, "  ​ x ", NOW)).rejects.toThrow(TaskInputError);
    await expect(skipTask(e, s.t("a").id, "x".repeat(301), NOW)).rejects.toThrow(TaskInputError);
    await expect(skipTask(e, s.t("a").id, "password: hunter2", NOW)).rejects.toThrow(/login or password/);
    await expect(skipTask(e, s.t("b").id, "Because I said so", NOW)).rejects.toThrow(TaskStateError);
    await expect(skipTask(e, s.t("c").id, "Because I said so", NOW)).rejects.toThrow(TaskStateError);
    await expect(skipTask(e, "nope", "Because I said so", NOW)).rejects.toThrow(/no such task/i);
    expect(await status(s.t("a").id)).toBe("todo");
    expect(await listComments(env.DB, s.t("a").id)).toEqual([]);
    expect((await skipTask(e, s.t("a").id, "x".repeat(300), NOW)).status).toBe("skipped");
  });

  it("reopen puts a done or skipped task back to todo, leaves a todo task alone and refuses one under way", async () => {
    const s = await setup([{ key: "a", skippable: true }, { key: "b" }, { key: "c", status: "in_progress" }, { key: "d" }]);
    await skipTask(e, s.t("a").id, "Not this time", NOW);
    expect((await reopenTask(e, s.t("a").id, NOW)).status).toBe("todo");
    await completeTask(e, s.t("b").id, { by, now: NOW });
    expect(await reopenTask(e, s.t("b").id, new Date(T2))).toMatchObject({ status: "todo", doneAt: null });
    expect((await reopenTask(e, s.t("d").id, NOW)).status).toBe("todo");
    await expect(reopenTask(e, s.t("c").id, NOW)).rejects.toThrow(TaskStateError);
    await expect(reopenTask(e, "nope", NOW)).rejects.toThrow(/no such task/i);
  });

  it("waiting on the client toggles on and back, returning to in_progress when the task was started", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }, { key: "c", status: "done" }]);
    expect((await setWaitingClient(e, s.t("a").id, true, NOW)).status).toBe("waiting_client");
    expect((await setWaitingClient(e, s.t("a").id, false, NOW)).status).toBe("todo");
    await startTask(e, s.t("b").id, NOW);
    expect((await setWaitingClient(e, s.t("b").id, true, NOW)).status).toBe("waiting_client");
    expect((await setWaitingClient(e, s.t("b").id, false, NOW)).status).toBe("in_progress");
    // switching it on or off twice is harmless
    expect((await setWaitingClient(e, s.t("b").id, false, NOW)).status).toBe("in_progress");
    await expect(setWaitingClient(e, s.t("c").id, true, NOW)).rejects.toThrow(TaskStateError);
  });
});

describe("updateTask and addAdhocTask", () => {
  it("updateTask applies the patch and refuses text that looks like a credential in any text field", async () => {
    const s = await setup([{ key: "a" }]);
    const id = s.t("a").id;
    expect(await updateTask(e, id, { title: "New title", estMinutes: 30 }, NOW)).toMatchObject({ title: "New title", estMinutes: 30, updatedAt: T1 });
    for (const p of [
      { title: "login: admin" }, { description: "the password = hunter2" }, { doneWhen: "api key: abc" }, { clientSummary: "token: abc" },
      { checklist: [{ text: "pwd: abc", done: false }] }, { description: "pass​word: sneaky" },
    ]) {
      const err = await updateTask(e, id, p, new Date(T2)).catch((x) => x);
      expect(err, JSON.stringify(p)).toBeInstanceOf(TaskInputError);
      expect(err.message).toMatch(/login or password/);
      expect(err.message).not.toMatch(/hunter2|sneaky|admin/);
    }
    expect(await getTask(env.DB, id)).toMatchObject({ title: "New title", description: "", updatedAt: T1 });
    await expect(updateTask(e, "nope", { title: "x" }, NOW)).rejects.toThrow(/no such task/i);
  });

  it("updateTask refuses requires that name a step that does not exist, itself, or a loop", async () => {
    const s = await setup([{ key: "a" }, { key: "b", requires: ["a"] }, { key: "c", requires: ["b"] }]);
    await expect(updateTask(e, s.t("c").id, { requires: ["b", "zzz"] }, NOW)).rejects.toThrow(/zzz/);
    await expect(updateTask(e, s.t("c").id, { requires: ["c"] }, NOW)).rejects.toThrow(/itself/);
    const loop = await updateTask(e, s.t("a").id, { requires: ["c"] }, NOW).catch((x) => x);
    expect(loop).toBeInstanceOf(TaskStateError);
    expect(loop.message).toMatch(/loop/);
    expect(loop.message).toMatch(/a → c → b → a/);
    expect((await getTask(env.DB, s.t("a").id))!.requires).toEqual([]);
    expect((await updateTask(e, s.t("c").id, { requires: ["a", "b"] }, NOW)).requires).toEqual(["a", "b"]);
    expect((await updateTask(e, s.t("c").id, { requires: [] }, NOW)).requires).toEqual([]);
  });

  it("updateTask still reports a bad value as a TaskInputError, including an impossible date", async () => {
    const s = await setup([{ key: "a" }]);
    await expect(updateTask(e, s.t("a").id, { dueOn: "2026-13-45" }, NOW)).rejects.toThrow(TaskInputError);
    await expect(updateTask(e, s.t("a").id, { title: "   " }, NOW)).rejects.toThrow(TaskInputError);
  });

  it("an owner or requires change runs the tasks-changed hook, and a title change does not", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }]);
    const c = vi.fn(async () => {});
    onTasksChanged(c);
    await updateTask(e, s.t("a").id, { title: "Renamed" }, NOW);
    expect(c).not.toHaveBeenCalled();
    await updateTask(e, s.t("a").id, { owner: "claude" }, NOW);
    await updateTask(e, s.t("b").id, { requires: ["a"] }, NOW);
    expect(c).toHaveBeenCalledTimes(2);
  });

  it("addAdhocTask adds a non-step task at the end with the given fields and runs the tasks-changed hook", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }]);
    const c = vi.fn(async () => {});
    onTasksChanged(c);
    const t = await addAdhocTask(e, { projectId: s.project.id, title: "  Chase the photos ", owner: "claude", estMinutes: 20, dueOn: "2026-12-10", billable: true }, NOW);
    expect(t).toMatchObject({
      projectId: s.project.id, businessId: s.businessId, isStep: false, stepKey: null, title: "Chase the photos", owner: "claude", estMinutes: 20, dueOn: "2026-12-10", billable: true,
      status: "todo", requires: [], milestone: null, changeOrderId: null, position: 2,
    });
    expect((await listTasks(env.DB, s.project.id)).map((x) => x.title)).toEqual(["Step a", "Step b", "Chase the photos"]);
    expect(c).toHaveBeenCalledWith(e, s.project.id);
  });

  it("addAdhocTask refuses a blank title, a bad date, text that looks like a credential, a missing or cancelled project, and bad requires", async () => {
    const s = await setup([{ key: "a" }]);
    const base = { projectId: s.project.id, title: "Extra", owner: "logan" as const };
    await expect(addAdhocTask(e, { ...base, title: "  " }, NOW)).rejects.toThrow(TaskInputError);
    await expect(addAdhocTask(e, { ...base, dueOn: "2026-13-45" }, NOW)).rejects.toThrow(TaskInputError);
    await expect(addAdhocTask(e, { ...base, title: "login: me" }, NOW)).rejects.toThrow(/login or password/);
    await expect(addAdhocTask(e, { ...base, projectId: "nope" }, NOW)).rejects.toThrow(/no such project/i);
    await expect(addAdhocTask(e, { ...base, requires: ["zzz"] }, NOW)).rejects.toThrow(/zzz/);
    await env.DB.prepare(`UPDATE projects SET status = 'cancelled' WHERE id = ?`).bind(s.project.id).run();
    await expect(addAdhocTask(e, base, NOW)).rejects.toThrow(TaskStateError);
    expect(await listTasks(env.DB, s.project.id)).toHaveLength(1);
  });

  it("an ad-hoc task that requires a step waits for it", async () => {
    const s = await setup([{ key: "a", title: "First thing" }]);
    const t = await addAdhocTask(e, { projectId: s.project.id, title: "After the first", owner: "logan", requires: ["a"] }, NOW);
    expect(t.requires).toEqual(["a"]);
    expect(await blockedBy(completeTask(e, t.id, { by, now: NOW }))).toEqual(["First thing"]);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect((await completeTask(e, t.id, { by, now: NOW })).status).toBe("done");
  });
});

describe("postComment", () => {
  it("a comment that looks like a credential is refused and not echoed", async () => {
    const s = await setup([{ key: "a" }]);
    const err = await postComment(e, s.t("a").id, "logan", "the login: admin password: hunter2", NOW).catch((x) => x);
    expect(err).toBeInstanceOf(TaskInputError);
    expect(err.message).toMatch(/login or password/);
    expect(err.message).not.toMatch(/hunter2|admin/);
    // a system author is not a way round it
    await expect(postComment(e, s.t("a").id, "system", "api key: abc123", NOW)).rejects.toThrow(TaskInputError);
    expect(await listComments(env.DB, s.t("a").id)).toEqual([]);
  });

  it("stores a clean comment, refuses an empty one and a missing task", async () => {
    const s = await setup([{ key: "a" }]);
    await postComment(e, s.t("a").id, "claude", "  Drafted the page ​copy.  ", NOW);
    expect(await listComments(env.DB, s.t("a").id)).toMatchObject([{ author: "claude", body: "Drafted the page copy.", createdAt: T1 }]);
    await expect(postComment(e, s.t("a").id, "logan", "   ", NOW)).rejects.toThrow(TaskInputError);
    await expect(postComment(e, "nope", "logan", "hello", NOW)).rejects.toThrow(/no such task/i);
  });
});

/** Makes a table refuse writes (the way a database error part-way through would), runs `fn`, and always puts the table back. */
async function failing<T>(trigger: string, fn: () => Promise<T>): Promise<void> {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run();
  await env.DB.prepare(`CREATE TRIGGER test_fail ${trigger}`).run();
  try { await fn(); } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run(); }
}
const milestoneRows = async (projectId: string) => (await listMilestones(env.DB, projectId)).length;

describe("replay safety", () => {
  it("a task saved as done by a request that died is settled by repeating it: milestone, log and hook once, then nothing", async () => {
    const s = await setup([{ key: "a", milestone: "design_approved" }, { key: "b" }]);
    const m = vi.fn(async () => {});
    const c = vi.fn(async () => {});
    onMilestone(m); onTasksChanged(c);
    // the crash: the status was committed, nothing after it ran
    expect(await setTaskStatus(env.DB, s.t("a").id, "done", { now: T0 })).toBe(true);
    expect(await milestoneRows(s.project.id)).toBe(0);
    const t = await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(t).toMatchObject({ status: "done", doneAt: T0 });
    expect(await milestoneRows(s.project.id)).toBe(1);
    expect(await kinds(s.businessId, "project_milestone")).toHaveLength(1);
    expect(m).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(m).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_milestone")).toHaveLength(1);
  });

  it("a database error while recording the milestone reaches the caller, and repeating the request records it once", async () => {
    const s = await setup([{ key: "a", milestone: "site_finished" }, { key: "b" }]);
    const m = vi.fn(async () => {});
    onMilestone(m);
    await failing(`BEFORE INSERT ON project_milestones BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, async () => {
      await expect(completeTask(e, s.t("a").id, { by, now: NOW })).rejects.toThrow();
    });
    expect(await status(s.t("a").id)).toBe("done");
    expect(await milestoneRows(s.project.id)).toBe(0);
    expect(await kinds(s.businessId, "project_milestone")).toEqual([]);
    expect(m).not.toHaveBeenCalled();
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect(await milestoneRows(s.project.id)).toBe(1);
    expect(await kinds(s.businessId, "project_milestone")).toHaveLength(1);
    expect(m).toHaveBeenCalledTimes(1);
  });

  it("a database error while finishing the project reaches the caller, and repeating the request finishes it once with its log, cadences and hooks", async () => {
    const s = await setup([{ key: "a" }, { key: "b" }], { kind: "care_onboarding" });
    const d = vi.fn(async () => {});
    onProjectDone(d);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await failing(`BEFORE UPDATE ON projects WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, async () => {
      await expect(completeTask(e, s.t("b").id, { by, now: NOW })).rejects.toThrow();
    });
    expect(await status(s.t("b").id)).toBe("done");
    expect((await getProject(env.DB, s.project.id))!.status).toBe("active");
    expect(await kinds(s.businessId, "project_done")).toEqual([]);
    expect(d).not.toHaveBeenCalled();
    await completeTask(e, s.t("b").id, { by, now: new Date(T2) });
    await completeTask(e, s.t("b").id, { by, now: new Date(T2) });
    expect(await getProject(env.DB, s.project.id)).toMatchObject({ status: "done", completedAt: T2 });
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
    expect((await listCadences(env.DB)).filter((c) => c.projectId === s.project.id).map((c) => c.templateKey).sort()).toEqual(["CARE-1", "CARE-4"]);
    expect(d).toHaveBeenCalledTimes(1);
  });

  it("a project that was finished but lost its cadences to a crash gets them on a replay, without running the done hooks again", async () => {
    const s = await setup([{ key: "a" }], { kind: "care_onboarding" });
    const d = vi.fn(async () => {});
    onProjectDone(d);
    await setTaskStatus(env.DB, s.t("a").id, "done", { now: T0 });
    await markProjectDone(env.DB, s.project.id, T0, { log: { businessId: s.businessId, detail: "x finished" } });
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect((await listCadences(env.DB)).filter((c) => c.projectId === s.project.id)).toHaveLength(2);
    expect(d).not.toHaveBeenCalled(); // hooks are at-most-once: the crashed request owned this one
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("the project finish and its log line are one change: a failing log leaves the project active", async () => {
    const s = await setup([{ key: "a" }]);
    await setTaskStatus(env.DB, s.t("a").id, "done", { now: T0 });
    await failing(`BEFORE INSERT ON activity WHEN NEW.kind = 'project_done' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, async () => {
      await expect(completeTask(e, s.t("a").id, { by, now: NOW })).rejects.toThrow();
    });
    expect((await getProject(env.DB, s.project.id))!.status).toBe("active");
    await completeTask(e, s.t("a").id, { by, now: NOW });
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("a skipped last step saved by a request that died finishes the project when the skip is repeated", async () => {
    const s = await setup([{ key: "a" }, { key: "b", skippable: true }]);
    const d = vi.fn(async () => {});
    onProjectDone(d);
    await completeTask(e, s.t("a").id, { by, now: NOW });
    await setTaskStatus(env.DB, s.t("b").id, "skipped", { now: T0 });
    await skipTask(e, s.t("b").id, "Client declined the extra", NOW);
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
    await skipTask(e, s.t("b").id, "Client declined the extra", NOW);
    expect(d).toHaveBeenCalledTimes(1);
    expect(await kinds(s.businessId, "project_done")).toHaveLength(1);
  });

  it("a skip and its reason are one change: a failing comment leaves the step as it was, and two skips at once leave one reason", async () => {
    const s = await setup([{ key: "a", skippable: true }, { key: "b", skippable: true }, { key: "c" }]);
    await failing(`BEFORE INSERT ON task_comments BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, async () => {
      await expect(skipTask(e, s.t("a").id, "No longer needed", NOW)).rejects.toThrow();
    });
    expect(await status(s.t("a").id)).toBe("todo");
    expect(await listComments(env.DB, s.t("a").id)).toEqual([]);
    await Promise.all([skipTask(e, s.t("b").id, "Client said no", NOW), skipTask(e, s.t("b").id, "Client said no", NOW)]);
    expect(await status(s.t("b").id)).toBe("skipped");
    expect(await listComments(env.DB, s.t("b").id)).toHaveLength(1);
  });
});
