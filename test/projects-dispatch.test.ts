import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { touchClient } from "../src/worker/db/onboardings";
import { setProjectStatus } from "../src/worker/db/projects";
import { getTask, insertTasks, listComments, TaskInputError, type NewTask } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onTasksChanged } from "../src/worker/projects/hooks";
import { MAX_IN_FLIGHT, dispatchOnTasksChanged, dispatchReady, requestClaudeStep } from "../src/worker/projects/dispatch";
import { completeTask, TaskStateError } from "../src/worker/projects/service";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
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
