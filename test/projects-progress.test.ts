import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createProject, setProjectStatus } from "../src/worker/db/projects";
import { insertTasks, setTaskStatus, type NewTask } from "../src/worker/db/tasks";
import { projectDoneNext } from "../src/worker/projects/progress";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";

const NOW = new Date("2026-11-20T17:00:00.000Z"); // a Friday morning in Los Angeles
const DAY = 86_400_000, HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const TZ = "America/Los_Angeles";

beforeEach(resetProjectWork);

interface Spec { key: string; summary?: string | null; title?: string; phase?: string; status?: NewTask["status"]; doneAgo?: number; isStep?: boolean }
/** Tasks in the order given (positions 0, 1, 2...), the done ones finished `doneAgo` ms before NOW. */
async function seed(projectId: string, businessId: string, specs: Spec[]) {
  const tasks = await insertTasks(env.DB, specs.map((s, i) => newTask(projectId, businessId, {
    stepKey: s.key, position: i, title: s.title ?? `Internal ${s.key}`, clientSummary: s.summary === undefined ? `Summary ${s.key}` : s.summary, phaseKey: s.phase ?? "p1", phaseTitle: s.phase ?? "p1",
    isStep: s.isStep ?? true,
  })));
  for (const [i, s] of specs.entries()) {
    if (s.status && s.status !== "todo") await setTaskStatus(env.DB, tasks[i].id, s.status, { now: s.status === "done" ? ago(s.doneAgo ?? 0) : ago(0) });
  }
  return tasks;
}

describe("projectDoneNext", () => {
  it("done lists only client-visible steps finished in 7 days, newest first", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [
      { key: "a", status: "done", doneAgo: 2 * DAY },
      { key: "b", status: "done", doneAgo: 9 * DAY }, // too old
      { key: "c", status: "done", doneAgo: 1 * DAY, summary: null, title: "Pull the update list and sort it by risk" }, // internal
      { key: "d", status: "done", doneAgo: HOUR },
      { key: "e", status: "skipped" }, // skipped is not done
      { key: "f", status: "todo" },
    ]);
    expect((await projectDoneNext(env.DB, s.businessId, NOW, TZ)).done).toEqual(["Summary d", "Summary a"]);
  });

  it("done is at most five, the newest five", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, status: "done" as const, doneAgo: (i + 1) * HOUR })));
    expect((await projectDoneNext(env.DB, s.businessId, NOW, TZ)).done).toEqual(["Summary k0", "Summary k1", "Summary k2", "Summary k3", "Summary k4"]);
  });

  it("next lists at most three in the current phase", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [
      { key: "a", phase: "p1", status: "done", doneAgo: 20 * DAY },
      { key: "b", phase: "p1" }, { key: "c", phase: "p1" }, { key: "d", phase: "p1" }, { key: "e", phase: "p1" }, { key: "f", phase: "p1", summary: null },
      { key: "g", phase: "p2" },
    ]);
    expect((await projectDoneNext(env.DB, s.businessId, NOW, TZ)).next).toEqual(["Summary b", "Summary c", "Summary d"]);
  });

  it("next moves to the following phase once the current one is finished", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [{ key: "a", phase: "p1", status: "done", doneAgo: 20 * DAY }, { key: "b", phase: "p2" }, { key: "c", phase: "p2" }, { key: "d", phase: "p3" }]);
    expect((await projectDoneNext(env.DB, s.businessId, NOW, TZ)).next).toEqual(["Summary b", "Summary c"]);
  });

  it("a task with no client summary never appears, in either list", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [
      { key: "a", summary: null, title: "Secret internal title one", status: "done", doneAgo: HOUR },
      { key: "b", summary: null, title: "Secret internal title two" },
      { key: "c", summary: "The home page is built" },
      { key: "d", isStep: false, summary: null, title: "Change order work" },
    ]);
    const r = await projectDoneNext(env.DB, s.businessId, NOW, TZ);
    expect(r).toEqual({ done: [], next: ["The home page is built"] });
    expect(JSON.stringify(r)).not.toContain("Secret internal");
  });

  it("a test project gives empty lists, and so does a cancelled one, and a lead with no project", async () => {
    const t = await seedProject({ bare: true, test: true });
    await seed(t.project.id, t.businessId, [{ key: "a", status: "done", doneAgo: HOUR }, { key: "b" }]);
    expect(await projectDoneNext(env.DB, t.businessId, NOW, TZ)).toEqual({ done: [], next: [] });
    const c = await seedProject({ bare: true });
    await seed(c.project.id, c.businessId, [{ key: "a", status: "done", doneAgo: HOUR }, { key: "b" }]);
    await setProjectStatus(env.DB, c.project.id, "cancelled");
    expect(await projectDoneNext(env.DB, c.businessId, NOW, TZ)).toEqual({ done: [], next: [] });
    expect(await projectDoneNext(env.DB, "no-such-lead", NOW, TZ)).toEqual({ done: [], next: [] });
  });

  it("a project that finished this week still lists what was done, and has nothing next", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [{ key: "a", status: "done", doneAgo: DAY }]);
    await setProjectStatus(env.DB, s.project.id, "done");
    expect(await projectDoneNext(env.DB, s.businessId, NOW, TZ)).toEqual({ done: ["Summary a"], next: [] });
  });

  it("merges a lead's projects: done newest first across them, next from each project's own current phase", async () => {
    const s = await seedProject({ bare: true });
    const { project: care } = await createProject(env.DB, {
      businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false,
      startedAt: "2026-12-04T10:00:00.000Z",
    });
    await seed(s.project.id, s.businessId, [{ key: "a", status: "done", doneAgo: 3 * DAY }, { key: "b" }]);
    await seed(care.id, s.businessId, [{ key: "x", status: "done", doneAgo: HOUR }, { key: "y" }]);
    expect(await projectDoneNext(env.DB, s.businessId, NOW, TZ)).toEqual({ done: ["Summary x", "Summary a"], next: ["Summary b", "Summary y"] });
  });

  it("the summary text is cleaned (control and bidirectional characters, runs of space) before it can reach a mail", async () => {
    const s = await seedProject({ bare: true });
    await seed(s.project.id, s.businessId, [{ key: "a", summary: "  Logo‮  and\u0007 photos\n in  " }]);
    expect((await projectDoneNext(env.DB, s.businessId, NOW, TZ)).next).toEqual(["Logo and photos in"]);
  });
});
