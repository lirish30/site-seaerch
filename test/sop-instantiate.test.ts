import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSeedSops, getTemplate, saveTemplate } from "../src/worker/db/sops";
import { listTasks } from "../src/worker/db/tasks";
import { instantiateSop, stepsFromTasks } from "../src/worker/sop/instantiate";
import { SEED_SOPS } from "../src/worker/sop/seeds";
import { seedProject } from "./fixtures/projects";

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

describe("instantiateSop", () => {
  it("instantiate copies every step with tag, estimate, done-when, requires and milestone", async () => {
    const template = (await getTemplate(env.DB, "BUILD"))!;
    const s = await seedProject();
    const tasks = await instantiateSop(env.DB, { project: s.project, template });
    expect(tasks).toHaveLength(template.steps.length);
    expect(await listTasks(env.DB, s.project.id)).toEqual(tasks);
    for (const [i, step] of template.steps.entries()) {
      const t = tasks[i];
      expect(t, step.key).toMatchObject({
        projectId: s.project.id, businessId: s.businessId, isStep: true, stepKey: step.key, phaseKey: step.phaseKey, phaseTitle: step.phaseTitle, position: step.position, title: step.title,
        description: "", owner: step.owner, status: "todo", doneWhen: step.doneWhen, estMinutes: step.estMinutes, dueOn: null, billable: false, skippable: step.skippable,
        requires: step.requires, milestone: step.milestone, clientSummary: step.clientSummary, docTemplate: step.docTemplate, emailTemplate: step.emailTemplate, checklist: [],
        changeOrderId: null, cadenceKey: null, periodKey: null, claudeTaskId: null, reviewApprovalId: null, startedAt: null, doneAt: null,
      });
    }
    const live = tasks.find((t) => t.stepKey === "7.4")!;
    expect(live.requires).toContain("7.2");
    expect(tasks.find((t) => t.stepKey === "4.5")!.milestone).toBe("design_approved");
    expect(tasks.find((t) => t.stepKey === "6.8")!.milestone).toBe("site_finished");
    expect(tasks.find((t) => t.stepKey === "4.3")!.owner).toBe("logan");
  });

  it("a template saved after instantiation leaves the project's tasks unchanged", async () => {
    const template = (await getTemplate(env.DB, "QUICKFIX"))!;
    const s = await seedProject({ kind: "quick_fix", templateKey: "QUICKFIX" });
    const before = await instantiateSop(env.DB, { project: s.project, template });
    const input = { ...template, steps: template.steps.map((st, i) => (i === 0 ? { ...st, title: "Changed after the fact", estMinutes: 999 % 600 } : st)).slice(0, -1) };
    const saved = await saveTemplate(env.DB, input);
    expect(saved.version).toBe(template.version + 1);
    expect(saved.steps[0].title).toBe("Changed after the fact");
    expect(await listTasks(env.DB, s.project.id)).toEqual(before);
  });

  it("instantiating twice for one project fails and adds nothing", async () => {
    const template = (await getTemplate(env.DB, "QUICKFIX"))!;
    const s = await seedProject({ kind: "quick_fix", templateKey: "QUICKFIX" });
    await instantiateSop(env.DB, { project: s.project, template });
    await expect(instantiateSop(env.DB, { project: s.project, template })).rejects.toThrow();
    expect(await listTasks(env.DB, s.project.id)).toHaveLength(template.steps.length);
  });
});

describe("stepsFromTasks", () => {
  it("stepsFromTasks round-trips instantiateSop for a template", async () => {
    for (const key of SEED_SOPS.filter((t) => t.kind === "project").map((t) => t.key)) {
      const template = (await getTemplate(env.DB, key))!;
      const s = await seedProject({ kind: "custom", templateKey: key });
      const tasks = await instantiateSop(env.DB, { project: s.project, template });
      expect(stepsFromTasks(tasks), key).toEqual(template.steps);
      // Order in the array does not matter: position does.
      expect(stepsFromTasks([...tasks].reverse()), key).toEqual(template.steps);
    }
  });

  it("skips tasks that are not steps", async () => {
    const template = (await getTemplate(env.DB, "QUICKFIX"))!;
    const s = await seedProject({ kind: "quick_fix", templateKey: "QUICKFIX" });
    const tasks = await instantiateSop(env.DB, { project: s.project, template });
    const extra = { ...tasks[0], id: "x", isStep: false, stepKey: null, position: 99 };
    const noKey = { ...tasks[0], id: "y", isStep: true, stepKey: null, position: 100 };
    expect(stepsFromTasks([...tasks, extra, noKey])).toEqual(template.steps);
  });
});
