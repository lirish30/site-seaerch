import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { touchClient } from "../src/worker/db/onboardings";
import { setProjectStatus } from "../src/worker/db/projects";
import { getTask, insertTasks, listComments, TaskInputError, type NewTask } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onTasksChanged, runTasksChanged } from "../src/worker/projects/hooks";
import { MAX_AUTO_RETRIES, MAX_IN_FLIGHT, dispatchOnTasksChanged, dispatchReady, requestClaudeStep } from "../src/worker/projects/dispatch";
import { completeTask, TaskStateError } from "../src/worker/projects/service";
import { expireOldTasks, finishClaudeTask, markTaskStale } from "../src/worker/queue/db";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import { claimById } from "./fixtures/draftTask";
import "../src/worker/queue/kinds";
import { newTask, resetProjectWork, seedProject, seedProjectWithOnboarding } from "./fixtures/projects";

const e = env as Env;
const NOW = new Date("2026-12-10T12:00:00.000Z");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

interface Spec { key: string; owner?: NewTask["owner"]; requires?: string[]; phaseKey?: string; status?: NewTask["status"] }
async function stepsFor(projectId: string, businessId: string, specs: Spec[]) {
  const tasks = await insertTasks(env.DB, specs.map((x, i) => newTask(projectId, businessId, {
    stepKey: x.key, position: i, title: `Step ${x.key}`, owner: x.owner ?? "claude", requires: x.requires ?? [], phaseKey: x.phaseKey ?? "p1", status: x.status ?? "todo",
  })));
  return (key: string) => tasks.find((t) => t.stepKey === key)!;
}
const jobs = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ? ORDER BY created_at, id`).bind(SOP_STEP_KIND).all<{ id: string; status: string; dedupe_key: string; target_type: string; target_id: string; payload: string }>()).results;
const status = async (id: string) => (await getTask(env.DB, id))!.status;

describe("dispatchReady", () => {
  it("queues a ready claude step for a real, active project and marks it in progress with the job's id", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }, { key: "l", owner: "logan" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "pending", dedupe_key: t("a").id, target_type: "task", target_id: t("a").id });
    expect(JSON.parse(job.payload)).toEqual({ taskId: t("a").id });
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "in_progress", claudeTaskId: job.id });
    expect(await status(t("l").id)).toBe("todo");
  });

  it("a paused project dispatches nothing", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    await setProjectStatus(env.DB, s.project.id, "paused", { reason: "invoice overdue" });
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toEqual([]);
    expect(await status(t("a").id)).toBe("todo");
  });

  it("a project waiting on client dispatches nothing and dispatches after a client write clears it", async () => {
    const sent = "2026-11-01T12:00:00.000Z"; // 39 days before NOW: well past the silence limit
    const s = await seedProjectWithOnboarding({ sentAt: sent });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toEqual([]);
    await touchClient(env.DB, s.onboarding.id, NOW.toISOString());
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await status(t("a").id)).toBe("in_progress");
  });

  it("a project whose onboarding is not waiting still dispatches", async () => {
    const s = await seedProjectWithOnboarding({ sentAt: "2026-12-09T12:00:00.000Z" });
    await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
  });

  it("a test project dispatches nothing but requestClaudeStep works", async () => {
    const s = await seedProject({ bare: true, test: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toEqual([]);
    expect(await requestClaudeStep(e, t("a").id)).toEqual({ queued: true });
    expect(await jobs()).toHaveLength(1);
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "in_progress" });
  });

  it("dispatching twice queues once", async () => {
    const s = await seedProject({ bare: true });
    await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toHaveLength(1);
  });

  it("no more than 5 are in flight", async () => {
    expect(MAX_IN_FLIGHT).toBe(5);
    const s = await seedProject({ bare: true });
    await stepsFor(s.project.id, s.businessId, ["a", "b", "c", "d", "e", "f", "g"].map((key) => ({ key })));
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 5 });
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toHaveLength(5);
    // Room opens when a job finishes: one more goes.
    await env.DB.prepare(`UPDATE claude_tasks SET status = 'done' WHERE id = (SELECT id FROM claude_tasks WHERE kind = ? LIMIT 1)`).bind(SOP_STEP_KIND).run();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await jobs()).toHaveLength(6);
  });

  it("the limit counts jobs across every project, and a smaller limit option is honored", async () => {
    const one = await seedProject({ bare: true });
    const two = await seedProject({ bare: true });
    await stepsFor(one.project.id, one.businessId, ["a", "b", "c"].map((key) => ({ key })));
    await stepsFor(two.project.id, two.businessId, ["a", "b", "c"].map((key) => ({ key })));
    expect(await dispatchReady(e, NOW, { limit: 2 })).toEqual({ queued: 2 });
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 3 });
    expect(await jobs()).toHaveLength(5);
  });

  it("only the current phase is dispatched", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }, { key: "b", phaseKey: "p2" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await status(t("b").id)).toBe("todo");
  });

  it("completing a step dispatches the next ready one", async () => {
    onTasksChanged(dispatchOnTasksChanged);
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "l", owner: "logan" }, { key: "c", requires: ["l"] }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    await completeTask(e, t("l").id, { by: "logan", now: NOW });
    expect(await jobs()).toHaveLength(1);
    expect(await status(t("c").id)).toBe("in_progress");
  });
});

describe("requestClaudeStep", () => {
  it("a note becomes a logan comment first, and a second request asks for nothing new", async () => {
    const s = await seedProject({ bare: true, test: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await requestClaudeStep(e, t("a").id, { note: "Use the shorter tone" })).toEqual({ queued: true });
    expect((await listComments(env.DB, t("a").id)).map((c) => [c.author, c.body])).toEqual([["logan", "Use the shorter tone"]]);
    expect(await requestClaudeStep(e, t("a").id)).toEqual({ queued: false });
    expect(await jobs()).toHaveLength(1);
  });

  it("a note that looks like a password is refused and nothing is queued", async () => {
    const s = await seedProject({ bare: true, test: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    await expect(requestClaudeStep(e, t("a").id, { note: "the password: hunter2" })).rejects.toThrow(TaskInputError);
    expect(await jobs()).toEqual([]);
    expect(await status(t("a").id)).toBe("todo");
  });

  it("refuses a done, skipped or locked step, a missing one, and a project that is not active", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a", status: "done" }, { key: "b", status: "skipped" }, { key: "c", status: "locked" }, { key: "d" }]);
    for (const k of ["a", "b", "c"]) await expect(requestClaudeStep(e, t(k).id)).rejects.toThrow(TaskStateError);
    await expect(requestClaudeStep(e, "nope")).rejects.toThrow(/no such task/i);
    await setProjectStatus(env.DB, s.project.id, "paused", { reason: "x" });
    await expect(requestClaudeStep(e, t("d").id)).rejects.toThrow(TaskStateError);
    expect(await jobs()).toEqual([]);
  });

  it("works on a step Logan owns (Ask Claude), and on one waiting in review (sent back)", async () => {
    const s = await seedProject({ bare: true, test: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a", owner: "logan" }, { key: "b", owner: "claude_drafts", status: "in_review" }]);
    expect(await requestClaudeStep(e, t("a").id)).toEqual({ queued: true });
    expect(await requestClaudeStep(e, t("b").id)).toEqual({ queued: true });
    expect(await getTask(env.DB, t("b").id)).toMatchObject({ status: "in_progress" });
  });
});

describe("retries and stranded steps", () => {
  const comments = async (id: string) => (await listComments(env.DB, id)).map((c) => c.body);
  const FAR = new Date("2027-02-01T00:00:00.000Z");
  /** Hands the step to Claude, claims the job, and returns it. */
  async function dispatched(taskId: string) {
    await dispatchReady(e, NOW);
    return claimById((await getTask(env.DB, taskId))!.claudeTaskId!);
  }

  it("a step whose jobs failed twice is not sent to Claude again, says so, and Ask Claude still works", async () => {
    expect(MAX_AUTO_RETRIES).toBe(2);
    onTasksChanged(dispatchOnTasksChanged);
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    const one = await dispatched(t("a").id);
    await finishClaudeTask(e, one.id, "failed", "cannot do it");
    expect(await comments(t("a").id)).toEqual(["Claude did not finish this step"]);
    const two = await dispatched(t("a").id);
    expect(two.id).not.toBe(one.id);
    await finishClaudeTask(e, two.id, "failed", "cannot do it either");
    expect(await comments(t("a").id)).toEqual(["Claude did not finish this step", "Claude could not do this step; it is yours. Press Ask Claude to try again"]);
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "todo", claudeTaskId: null });
    // Any change anywhere runs the hook; no third job is made.
    await runTasksChanged(e, s.project.id);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toHaveLength(2);
    // Logan can still force it.
    expect(await requestClaudeStep(e, t("a").id)).toEqual({ queued: true });
    expect(await jobs()).toHaveLength(3);
  });

  it("expired jobs count too", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    const one = await dispatched(t("a").id);
    await finishClaudeTask(e, one.id, "failed", "no");
    const two = await dispatched(t("a").id);
    await env.DB.prepare(`UPDATE claude_tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).bind(two.id).run();
    expect(await expireOldTasks(e, FAR)).toBe(1);
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "todo", claudeTaskId: null });
    expect(await comments(t("a").id)).toEqual(["Claude did not finish this step", "Claude could not do this step; it is yours. Press Ask Claude to try again"]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toHaveLength(2);
  });

  it("a step left in progress under a job that has ended goes back to to do and is sent again", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    const one = await dispatched(t("a").id);
    await markTaskStale(env.DB, one.id, "something else");
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "in_progress", claudeTaskId: one.id });
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    const now = (await getTask(env.DB, t("a").id))!;
    expect(now.status).toBe("in_progress");
    expect(now.claudeTaskId).not.toBe(one.id);
    expect(await jobs()).toHaveLength(2);
  });

  it("a step Logan touched after the job ended is left alone", async () => {
    const s = await seedProject({ bare: true });
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    const one = await dispatched(t("a").id);
    await markTaskStale(env.DB, one.id, "something else");
    await env.DB.prepare(`UPDATE tasks SET updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`).bind(t("a").id).run();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await getTask(env.DB, t("a").id)).toMatchObject({ status: "in_progress", claudeTaskId: one.id });
    expect(await comments(t("a").id)).toEqual([]);
  });
});

describe("an onboarding that started after the project (F3)", () => {
  it("a project made before its onboarding existed (onboardingId null) still waits on the silent client, and a client write clears it", async () => {
    const s = await seedProjectWithOnboarding({ sentAt: "2026-11-01T12:00:00.000Z" });
    await env.DB.prepare(`UPDATE projects SET onboarding_id = NULL WHERE id = ?`).bind(s.project.id).run();
    const t = await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toEqual([]);
    await touchClient(env.DB, s.onboarding.id, NOW.toISOString());
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await status(t("a").id)).toBe("in_progress");
  });

  it("a test onboarding is not used for a real project, and a real one is not used for a test project", async () => {
    const s = await seedProjectWithOnboarding({ sentAt: "2026-11-01T12:00:00.000Z", test: true });
    await env.DB.prepare(`UPDATE projects SET onboarding_id = NULL, test = 0 WHERE id = ?`).bind(s.project.id).run();
    await stepsFor(s.project.id, s.businessId, [{ key: "a" }]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 }); // the test onboarding's silence does not hold a real project
  });
});

describe("a finished Care project is never waiting on its onboarding (F6)", () => {
  it("keeps dispatching its recurring Claude work after 14 days of onboarding silence, while the same silence still holds a build", async () => {
    const sent = "2026-11-01T12:00:00.000Z";
    const care = await seedProjectWithOnboarding({ sentAt: sent });
    await env.DB.prepare(`UPDATE projects SET kind = 'care_onboarding', status = 'done' WHERE id = ?`).bind(care.project.id).run();
    const [recurring] = await insertTasks(env.DB, [newTask(care.project.id, care.businessId, {
      isStep: false, stepKey: null, phaseKey: "recurring", title: "Weekly Care update", owner: "claude", cadenceKey: "CARE-1", periodKey: "2026-W50",
    })]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect(await status(recurring.id)).toBe("in_progress");
    // an unfinished Care onboarding (active) is still held by the silence, like any build
    await env.DB.prepare(`UPDATE projects SET status = 'active' WHERE id = ?`).bind(care.project.id).run();
    await env.DB.prepare(`UPDATE tasks SET status = 'todo', claude_task_id = NULL WHERE id = ?`).bind(recurring.id).run();
    await env.DB.prepare(`DELETE FROM claude_tasks`).run();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
  });
});
