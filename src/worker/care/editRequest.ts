import type { Env } from "../env";
import { isOnHold } from "../db/holds";
import { listProjects, projectIsLive } from "../db/projects";
import { getSettings } from "../db/settings";
import { ensureSeedSops, getTemplate } from "../db/sops";
import { insertTasks, listTasks, type NewTask } from "../db/tasks";
import { localDay } from "../monitoring/rollup";
import { cleanText } from "../onboarding/templates";
import { zoneOf } from "../sop/cadence";
import { OWNER_LABEL } from "../sop/model";
import { SEED_SOPS } from "../sop/seeds";

// A client's edit request (CARE-3, Plan 13): one task on the client's live Care project whose checklist is the CARE-3 steps. The task is never billable, and the ledger counts only
// the time logged on tasks flagged `editRequest`, so this task is what uses up the client's monthly edit hours.

/** The CARE-3 checklist template: the five steps of an edit request. It is never started as a project; its steps are the task's checklist. */
export const CARE_3_KEY = "CARE-3";

const TITLE_MAX = 120;

/**
 * Makes the task for one edit request on the client's live Care project: owner Logan, `editRequest`, not billable, not a step, no cadence and no change order, the template's steps as the checklist
 * (`<step title> (<owner label>)`, as a recurring task writes them), due today in the booking zone. Two requests make two tasks. Refuses with a plain sentence, and makes nothing, for a client with no
 * live Care project, one on a billing hold, or a title that is empty once cleaned (the title is cut to 120 characters).
 */
export async function createEditRequest(env: Env, businessId: string, o: { title: string; now: Date }): Promise<{ taskId: string } | { refused: string }> {
  const db = env.DB;
  const title = cleanText(o.title, TITLE_MAX);
  if (!title) return { refused: "Give the edit request a title." };
  const project = (await listProjects(db, { businessId })).find((p) => p.kind === "care_onboarding" && projectIsLive(p));
  if (!project) return { refused: "This client has no live Care project, so there is nowhere to put an edit request." };
  if (await isOnHold(db, businessId)) return { refused: "This client is on a billing hold, so no edit request was added. Lift the hold first." };

  let template = await getTemplate(db, CARE_3_KEY);
  if (!template) { await ensureSeedSops(db); template = await getTemplate(db, CARE_3_KEY); }
  const steps = template?.steps ?? SEED_SOPS.find((t) => t.key === CARE_3_KEY)!.steps;
  const tasks = await listTasks(db, project.id);
  const task: NewTask = {
    projectId: project.id, businessId, isStep: false, stepKey: null, phaseKey: "edits", phaseTitle: "Edit requests", position: tasks.reduce((m, t) => Math.max(m, t.position), -1) + 1,
    title, description: "", owner: "logan", status: "todo", doneWhen: "The change is live, the client has had a reply with the before and after, and the time is logged.",
    estMinutes: steps.reduce((n, s) => n + s.estMinutes, 0), dueOn: localDay(o.now.toISOString(), zoneOf(await getSettings(db))), billable: false, skippable: false, requires: [], milestone: null,
    clientSummary: null, docTemplate: null, emailTemplate: null, checklist: steps.map((s) => ({ text: `${s.title} (${OWNER_LABEL[s.owner]})`, done: false })),
    changeOrderId: null, cadenceKey: null, periodKey: null, editRequest: true,
  };
  const [made] = await insertTasks(db, [task]);
  return { taskId: made.id };
}
