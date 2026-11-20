import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal } from "../src/worker/db/deals";
import { addCadence, createProject, getProject, hasProject, listCadences, listMilestones, listProjects, markProjectDone, reachMilestone, setProjectStatus } from "../src/worker/db/projects";
import { setTaskStatus } from "../src/worker/db/tasks";
import { seedDoc, seedProject, seedSteps, T0, T1, T2 } from "./fixtures/projects";
import { seedDeal } from "./fixtures/documents";

describe("createProject", () => {
  it("createProject is idempotent per document and template", async () => {
    const s = await seedProject();
    expect(s.created).toBe(true);
    expect(s.project).toMatchObject({
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, onboardingId: null, kind: "build", name: "Website build", status: "active", pausedReason: null,
      test: false, templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: T0, completedAt: null,
    });
    expect(s.project.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const again = await createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, onboardingId: null, kind: "quick_fix", name: "Other name", test: true, templateKey: "BUILD", templateVersion: 2,
      careDeferred: true, startedAt: T1,
    });
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(s.project.id);
    expect(again.project).toMatchObject({ kind: "build", name: "Website build", test: false, templateVersion: 1, careDeferred: false, startedAt: T0 });
    // A different template for the same document is its own project.
    const care = await createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1,
      careDeferred: true, startedAt: T0,
    });
    expect(care.created).toBe(true);
    expect(care.project.id).not.toBe(s.project.id);
    expect(care.project.careDeferred).toBe(true);
    expect((await getProject(env.DB, s.project.id))!.id).toBe(s.project.id);
    expect(await getProject(env.DB, "nope")).toBeNull();
  });

  it("hand-made projects (no document) are not limited to one", async () => {
    const a = await seedProject({ bare: true, templateKey: null, kind: "custom", name: "One" });
    const b = await createProject(env.DB, {
      businessId: a.businessId, dealId: null, documentId: null, onboardingId: null, kind: "custom", name: "Two", test: false, templateKey: null, templateVersion: null, careDeferred: false, startedAt: T0,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.project.id).not.toBe(a.project.id);
    expect(a.project).toMatchObject({ dealId: null, documentId: null, templateKey: null, templateVersion: null });
  });

  it("a project for a test document is a test project", async () => {
    const real = await seedProject({ test: false });
    const test = await seedProject({ test: true });
    expect(real.project.test).toBe(false);
    expect(test.project.test).toBe(true);
    expect((await getProject(env.DB, test.project.id))!.test).toBe(true);
  });

  it("an invalid kind rejects instead of returning silently", async () => {
    const s = await seedDoc();
    await expect(createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, onboardingId: null, kind: "bogus" as unknown as "build", name: "x", test: false, templateKey: "BUILD",
      templateVersion: 1, careDeferred: false, startedAt: T0,
    })).rejects.toThrow();
  });
});

describe("hasProject and listProjects", () => {
  it("hasProject is true once the lead has any project", async () => {
    const s = await seedDeal();
    expect(await hasProject(env.DB, s.businessId)).toBe(false);
    await createProject(env.DB, { businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "custom", name: "x", test: false, templateKey: null, templateVersion: null, careDeferred: false, startedAt: T0 });
    expect(await hasProject(env.DB, s.businessId)).toBe(true);
  });

  it("listProjects filters by status and business and counts open and done tasks", async () => {
    const a = await seedProject({ name: "Alpha" });
    const b = await seedProject({ name: "Beta" });
    const tasks = await seedSteps(a.project.id, a.businessId, [{ key: "1" }, { key: "2" }, { key: "3" }, { key: "4" }]);
    await setTaskStatus(env.DB, tasks[0].id, "done", { now: T1 });
    await setTaskStatus(env.DB, tasks[1].id, "skipped", { now: T1 });
    await setProjectStatus(env.DB, b.project.id, "paused", { reason: "invoice overdue", now: T1 });

    const mine = await listProjects(env.DB, { businessId: a.businessId });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: a.project.id, name: "Alpha", openTasks: 2, doneTasks: 2 });
    expect(mine[0].businessName).toBeTruthy();

    const active = (await listProjects(env.DB, { status: ["active"] })).map((p) => p.id);
    expect(active).toContain(a.project.id);
    expect(active).not.toContain(b.project.id);
    const paused = await listProjects(env.DB, { status: ["paused"], businessId: b.businessId });
    expect(paused.map((p) => p.id)).toEqual([b.project.id]);
    expect(paused[0]).toMatchObject({ openTasks: 0, doneTasks: 0, pausedReason: "invoice overdue" });
    const all = (await listProjects(env.DB)).map((p) => p.id);
    expect(all).toEqual(expect.arrayContaining([a.project.id, b.project.id]));
    expect(await listProjects(env.DB, { status: [] })).toEqual([]);
  });
});

describe("setProjectStatus", () => {
  it("done stamps completedAt and pause keeps its reason", async () => {
    const s = await seedProject();
    const paused = await setProjectStatus(env.DB, s.project.id, "paused", { reason: "waiting on payment", now: T1 });
    expect(paused).toMatchObject({ status: "paused", pausedReason: "waiting on payment", completedAt: null, updatedAt: T1 });
    const active = await setProjectStatus(env.DB, s.project.id, "active", { now: T1 });
    expect(active).toMatchObject({ status: "active", pausedReason: null });
    const done = await setProjectStatus(env.DB, s.project.id, "done", { now: T2 });
    expect(done).toMatchObject({ status: "done", completedAt: T2, pausedReason: null });
  });

  it("done and cancelled projects never reopen", async () => {
    const d = await seedProject();
    await setProjectStatus(env.DB, d.project.id, "done", { now: T1 });
    for (const to of ["active", "paused", "cancelled"] as const) {
      const r = await setProjectStatus(env.DB, d.project.id, to, { now: T2 });
      expect(r, to).toMatchObject({ status: "done", completedAt: T1, updatedAt: T1 });
    }
    const c = await seedProject();
    await setProjectStatus(env.DB, c.project.id, "cancelled", { now: T1 });
    for (const to of ["active", "paused", "done"] as const) {
      const r = await setProjectStatus(env.DB, c.project.id, to, { now: T2 });
      expect(r, to).toMatchObject({ status: "cancelled", completedAt: null });
    }
  });

  it("a finished Care onboarding project can be cancelled (its service stops), and nothing else moves it", async () => {
    const c = await seedProject({ kind: "care_onboarding", templateKey: "CARE-0" });
    await setProjectStatus(env.DB, c.project.id, "done", { now: T1 });
    for (const to of ["active", "paused", "done"] as const) {
      expect(await setProjectStatus(env.DB, c.project.id, to, { now: T2 }), to).toMatchObject({ status: "done", completedAt: T1, updatedAt: T1 });
    }
    expect(await setProjectStatus(env.DB, c.project.id, "cancelled", { now: T2 })).toMatchObject({ status: "cancelled", completedAt: T1, updatedAt: T2 });
    // cancelled is final, and an active or paused Care project is cancelled as before
    expect(await setProjectStatus(env.DB, c.project.id, "active", { now: T2 })).toMatchObject({ status: "cancelled" });
    // a finished build or quick fix still cannot be cancelled
    const b = await seedProject({ kind: "quick_fix", templateKey: "QUICKFIX" });
    await setProjectStatus(env.DB, b.project.id, "done", { now: T1 });
    expect(await setProjectStatus(env.DB, b.project.id, "cancelled", { now: T2 })).toMatchObject({ status: "done" });
  });

  it("an unknown project rejects", async () => {
    await expect(setProjectStatus(env.DB, "nope", "done", { now: T1 })).rejects.toThrow();
  });
});

describe("markProjectDone", () => {
  it("is true only for the call that finished the project, and a second or concurrent call gets false", async () => {
    const s = await seedProject();
    expect(await markProjectDone(env.DB, s.project.id, T1)).toBe(true);
    expect(await getProject(env.DB, s.project.id)).toMatchObject({ status: "done", completedAt: T1, pausedReason: null, updatedAt: T1 });
    expect(await markProjectDone(env.DB, s.project.id, T2)).toBe(false);
    expect((await getProject(env.DB, s.project.id))!.completedAt).toBe(T1);
    const c = await seedProject();
    const r = await Promise.all([markProjectDone(env.DB, c.project.id, T1), markProjectDone(env.DB, c.project.id, T1), markProjectDone(env.DB, c.project.id, T1)]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("finishes a paused project but never a cancelled one, and a missing project is false", async () => {
    const p = await seedProject();
    await setProjectStatus(env.DB, p.project.id, "paused", { reason: "invoice overdue", now: T0 });
    expect(await markProjectDone(env.DB, p.project.id, T1)).toBe(true);
    expect(await getProject(env.DB, p.project.id)).toMatchObject({ status: "done", pausedReason: null });
    const c = await seedProject();
    await setProjectStatus(env.DB, c.project.id, "cancelled", { now: T0 });
    expect(await markProjectDone(env.DB, c.project.id, T1)).toBe(false);
    expect((await getProject(env.DB, c.project.id))!.status).toBe("cancelled");
    expect(await markProjectDone(env.DB, "nope", T1)).toBe(false);
  });
});

describe("changes that log themselves", () => {
  const lines = async (businessId: string, kind: string) => (await env.DB.prepare(`SELECT detail FROM activity WHERE business_id = ? AND kind = ?`).bind(businessId, kind).all<{ detail: string }>()).results.map((r) => r.detail);

  it("markProjectDone writes its timeline line with the change, once, and a refused change writes none", async () => {
    const s = await seedProject();
    expect(await markProjectDone(env.DB, s.project.id, T1, { log: { businessId: s.businessId, detail: "Website build finished" } })).toBe(true);
    expect(await markProjectDone(env.DB, s.project.id, T2, { log: { businessId: s.businessId, detail: "Website build finished" } })).toBe(false);
    expect(await lines(s.businessId, "project_done")).toEqual(["Website build finished"]);
    const c = await seedProject();
    await setProjectStatus(env.DB, c.project.id, "cancelled", { now: T0 });
    expect(await markProjectDone(env.DB, c.project.id, T1, { log: { businessId: c.businessId, detail: "nope" } })).toBe(false);
    expect(await lines(c.businessId, "project_done")).toEqual([]);
  });

  it("reachMilestone writes its timeline line only the first time", async () => {
    const s = await seedProject();
    expect(await reachMilestone(env.DB, s.project.id, "site_finished", T1, { log: { businessId: s.businessId, detail: "Website build: site finished" } })).toBe(true);
    expect(await reachMilestone(env.DB, s.project.id, "site_finished", T2, { log: { businessId: s.businessId, detail: "Website build: site finished" } })).toBe(false);
    expect(await lines(s.businessId, "project_milestone")).toEqual(["Website build: site finished"]);
  });
});

describe("milestones and cadences", () => {
  it("reachMilestone is true once", async () => {
    const s = await seedProject();
    expect(await reachMilestone(env.DB, s.project.id, "design_approved", T1)).toBe(true);
    expect(await reachMilestone(env.DB, s.project.id, "design_approved", T2)).toBe(false);
    expect(await reachMilestone(env.DB, s.project.id, "site_finished", T2)).toBe(true);
    expect(await listMilestones(env.DB, s.project.id)).toEqual([
      { milestone: "design_approved", reachedAt: T1 }, { milestone: "site_finished", reachedAt: T2 },
    ]);
    expect(await listMilestones(env.DB, "nope")).toEqual([]);
  });

  it("addCadence twice stores one", async () => {
    const s = await seedProject();
    expect(await addCadence(env.DB, s.project.id, "CARE-1")).toBe(true);
    expect(await addCadence(env.DB, s.project.id, "CARE-1")).toBe(false);
    expect(await addCadence(env.DB, s.project.id, "CARE-4")).toBe(true);
    const mine = (await listCadences(env.DB)).filter((c) => c.projectId === s.project.id);
    expect(mine.map((c) => c.templateKey).sort()).toEqual(["CARE-1", "CARE-4"]);
    expect(mine[0].id).toBeTruthy();
  });

  it("listCadences can be limited to live projects: active ones and finished Care onboarding, not paused, cancelled or finished builds", async () => {
    const live = await seedProject();
    const care = await seedProject({ kind: "care_onboarding", templateKey: "CARE-0" });
    const build = await seedProject();
    const stopped = await seedProject();
    const paused = await seedProject();
    for (const s of [live, care, build, stopped, paused]) await addCadence(env.DB, s.project.id, "CARE-1");
    await setProjectStatus(env.DB, stopped.project.id, "cancelled", { now: T1 });
    await setProjectStatus(env.DB, paused.project.id, "paused", { now: T1 });
    await setProjectStatus(env.DB, care.project.id, "done", { now: T1 });
    await setProjectStatus(env.DB, build.project.id, "done", { now: T1 });
    const ids = (o?: { liveProjectsOnly?: boolean }) => listCadences(env.DB, o).then((l) => l.map((c) => c.projectId));
    expect(await ids()).toEqual(expect.arrayContaining([live.project.id, care.project.id, build.project.id, stopped.project.id, paused.project.id]));
    const found = await ids({ liveProjectsOnly: true });
    expect(found).toContain(live.project.id);
    expect(found).toContain(care.project.id);
    for (const s of [build, stopped, paused]) expect(found).not.toContain(s.project.id);
  });
});

describe("the lead delete route", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const del = (id: string) => SELF.fetch(`https://x/api/leads/${id}`, { method: "DELETE", headers: { cookie } });

  it("the lead delete route refuses a lead that has a project", async () => {
    const s = await seedProject({ bare: true, templateKey: null, kind: "custom" });
    const res = await del(s.businessId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "this lead has a project" });
    expect(await getBusiness(env.DB, s.businessId)).not.toBeNull();
    expect(await getDeal(env.DB, s.dealId)).not.toBeNull();
    expect(await getProject(env.DB, s.project.id)).not.toBeNull();
  });
});
