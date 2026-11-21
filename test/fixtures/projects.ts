import { env } from "cloudflare:test";
import { createDraft } from "../../src/worker/db/documents";
import { createProject, type Project } from "../../src/worker/db/projects";
import { createOnboarding, listItems, markWelcomeSent, saveAnswers, saveItemText } from "../../src/worker/db/onboardings";
import { insertTasks, type NewTask, type Task } from "../../src/worker/db/tasks";
import { dueDatesFor } from "../../src/worker/onboarding/schedule";
import { proposal, seedDeal } from "./documents";

export const T0 = "2026-12-03T10:00:00.000Z";
export const T1 = "2026-12-03T11:00:00.000Z";
export const T2 = "2026-12-03T12:00:00.000Z";

/** A lead with a deal and a draft document (a project hangs off all three). */
export async function seedDoc() {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  return { ...s, documentId: doc.id };
}

/** A project for a fresh lead, started from a draft document unless `bare` (a hand-made project has no deal, document or onboarding). */
export async function seedProject(o: { bare?: boolean; test?: boolean; templateKey?: string | null; kind?: Project["kind"]; name?: string } = {}) {
  const s = o.bare ? { ...(await seedDeal()), documentId: null } : await seedDoc();
  const templateKey = o.templateKey === undefined ? "BUILD" : o.templateKey;
  const { project, created } = await createProject(env.DB, {
    businessId: s.businessId, dealId: o.bare ? null : s.dealId, documentId: s.documentId, onboardingId: null, kind: o.kind ?? "build", name: o.name ?? "Website build",
    test: o.test ?? false, templateKey, templateVersion: templateKey ? 1 : null, careDeferred: false, startedAt: T0,
  });
  return { ...s, project, created };
}

/** A step task with sensible defaults; `position` defaults to the array index when made with `steps`. */
export const newTask = (projectId: string, businessId: string, o: Partial<NewTask> = {}): NewTask => ({
  projectId, businessId, isStep: true, stepKey: null, phaseKey: "p1", phaseTitle: "Phase one", position: 0, title: "A task", description: "", owner: "logan", status: "todo",
  doneWhen: "", estMinutes: 15, dueOn: null, billable: false, skippable: false, requires: [], milestone: null, clientSummary: null, docTemplate: null, emailTemplate: null,
  checklist: [], changeOrderId: null, cadenceKey: null, periodKey: null, ...o,
});

/** Inserts tasks keyed by their step key, positions 0, 1, 2... */
export async function seedSteps(projectId: string, businessId: string, specs: { key: string; requires?: string[]; owner?: Task["owner"]; title?: string }[]): Promise<Task[]> {
  return insertTasks(env.DB, specs.map((s, i) => newTask(projectId, businessId, { stepKey: s.key, position: i, title: s.title ?? `Step ${s.key}`, requires: s.requires ?? [], owner: s.owner ?? "logan" })));
}

/**
 * A real project (never bare) started from a draft document with an onboarding attached. `sentAt` marks the welcome as sent then (so the onboarding's silence runs from it);
 * `answers` are saved as the client's questionnaire answers, and `items` are given to the client's checklist with the text the client typed.
 */
export async function seedProjectWithOnboarding(o: { test?: boolean; sentAt?: string; answers?: Record<string, string>; items?: { key: string; label: string; text: string }[] } = {}) {
  const s = await seedDoc();
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "build", test: o.test ?? false,
    items: (o.items ?? []).map((i) => ({ key: i.key, label: i.label, instructions: "Type it here.", kind: "text" as const, phase: 1 as const })),
  });
  if (o.sentAt) await markWelcomeSent(env.DB, onboarding.id, { sentAt: o.sentAt, ...dueDatesFor(new Date(o.sentAt)) });
  if (o.answers) await saveAnswers(env.DB, onboarding.id, o.answers, T0);
  for (const i of o.items ?? []) {
    const row = (await listItems(env.DB, onboarding.id)).find((x) => x.key === i.key)!;
    await saveItemText(env.DB, row.id, i.text, T0);
  }
  const { project } = await createProject(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, onboardingId: onboarding.id, kind: "build", name: "Website build",
    test: o.test ?? false, templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: T0,
  });
  return { ...s, project, onboarding };
}

/** Empties the site records and the project tables (change orders too), the Claude queue and the review and change-order approvals, for a test that counts them or dispatches across every project. */
export async function resetProjectWork() {
  // Site records point at businesses, so they go first: a test that then clears businesses does not hit the foreign key.
  await env.DB.batch(["site_access_items", "sites"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch(["task_comments", "time_entries", "tasks", "change_order_views", "change_orders", "project_milestones", "project_cadences", "projects", "claude_tasks", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM approvals WHERE kind IN ('sop.review', 'change_order.send')`).run();
}
