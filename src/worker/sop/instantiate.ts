import type { Project } from "../db/projects";
import { insertTasks, type NewTask, type Task } from "../db/tasks";
import type { SopStep, SopTemplate } from "./model";

/**
 * Copies a template's steps into the project as tasks, in one batch. The tasks are the project's SOP from then on: saving the template later changes nothing here.
 * Every task starts as `todo`, unbilled and undated. A project that already has one of these step keys fails the whole batch and gets no tasks.
 */
export async function instantiateSop(db: D1Database, o: { project: Project; template: SopTemplate }): Promise<Task[]> {
  const rows: NewTask[] = o.template.steps.map((s) => ({
    projectId: o.project.id, businessId: o.project.businessId, isStep: true, stepKey: s.key, phaseKey: s.phaseKey, phaseTitle: s.phaseTitle, position: s.position, title: s.title,
    description: "", owner: s.owner, status: "todo", doneWhen: s.doneWhen, estMinutes: s.estMinutes, dueOn: null, billable: false, skippable: s.skippable, requires: [...s.requires],
    milestone: s.milestone, clientSummary: s.clientSummary, docTemplate: s.docTemplate, emailTemplate: s.emailTemplate, checklist: [], changeOrderId: null, cadenceKey: null, periodKey: null, editRequest: false,
  }));
  return insertTasks(db, rows);
}

/** The inverse of `instantiateSop`: the project's step tasks, in order, as template steps (a task that is not a step is left out). Used when the owner pushes a project's edits back to its template. */
export function stepsFromTasks(tasks: Task[]): SopStep[] {
  return tasks
    .filter((t) => t.isStep && t.stepKey !== null)
    .sort((a, b) => a.position - b.position)
    .map((t) => ({
      key: t.stepKey!, phaseKey: t.phaseKey, phaseTitle: t.phaseTitle, position: t.position, title: t.title, owner: t.owner, estMinutes: t.estMinutes, doneWhen: t.doneWhen,
      docTemplate: t.docTemplate, emailTemplate: t.emailTemplate, requires: [...t.requires], milestone: t.milestone, clientSummary: t.clientSummary, skippable: t.skippable,
    }));
}
