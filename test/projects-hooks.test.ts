import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProject } from "../src/worker/db/projects";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onMilestone, onProjectDone, onTasksChanged, runMilestone, runProjectDone, runTasksChanged } from "../src/worker/projects/hooks";
import { seedProject } from "./fixtures/projects";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

const e = env as Env;

describe("project hooks", () => {
  it("runs every registered done hook, in order, with the env and the project", async () => {
    const s = await seedProject({ bare: true });
    const seen: string[] = [];
    onProjectDone(async (en, p) => { expect(en).toBe(e); seen.push(`a:${p.id}`); });
    onProjectDone(async (_en, p) => { seen.push(`b:${p.id}`); });
    await runProjectDone(e, s.project);
    expect(seen).toEqual([`a:${s.project.id}`, `b:${s.project.id}`]);
  });

  it("a hook that throws is logged and swallowed, and the others still run", async () => {
    const s = await seedProject({ bare: true });
    const after = vi.fn(async () => {});
    onProjectDone(async () => { throw new Error("boom"); });
    onProjectDone(after);
    await expect(runProjectDone(e, s.project)).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0].join(" "))).toMatch(/boom/);
  });

  it("a hook that rejects with something that is not an Error is also logged and swallowed", async () => {
    const s = await seedProject({ bare: true });
    onMilestone(async () => { throw "plain string"; });
    await expect(runMilestone(e, s.project, "design_approved")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("milestone hooks get the milestone key and tasks-changed hooks get the project id", async () => {
    const s = await seedProject({ bare: true });
    const m = vi.fn(async () => {});
    const t = vi.fn(async () => {});
    onMilestone(m);
    onTasksChanged(t);
    await runMilestone(e, s.project, "site_finished");
    await runTasksChanged(e, s.project.id);
    expect(m).toHaveBeenCalledWith(e, s.project, "site_finished");
    expect(t).toHaveBeenCalledWith(e, s.project.id);
  });

  it("with no hooks registered, running them does nothing", async () => {
    const s = await seedProject({ bare: true });
    await runProjectDone(e, s.project);
    await runMilestone(e, s.project, "design_approved");
    await runTasksChanged(e, s.project.id);
    expect(errors).not.toHaveBeenCalled();
    expect((await getProject(env.DB, s.project.id))!.status).toBe("active");
  });

  it("clearProjectHooksForTests removes every kind of hook", async () => {
    const s = await seedProject({ bare: true });
    const f = vi.fn(async () => {});
    onProjectDone(f); onMilestone(f); onTasksChanged(f);
    clearProjectHooksForTests();
    await runProjectDone(e, s.project);
    await runMilestone(e, s.project, "design_approved");
    await runTasksChanged(e, s.project.id);
    expect(f).not.toHaveBeenCalled();
  });

  it("a hook registered while hooks are running does not run in that pass", async () => {
    const s = await seedProject({ bare: true });
    const late = vi.fn(async () => {});
    onTasksChanged(async () => { onTasksChanged(late); });
    await runTasksChanged(e, s.project.id);
    expect(late).not.toHaveBeenCalled();
    await runTasksChanged(e, s.project.id);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
