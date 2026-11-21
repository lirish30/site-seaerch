import type { Env } from "../env";
import type { CareRun } from "../db/careUpdates";
import { closeIncident, openIncident } from "../db/monitoring";
import { listProjects, projectIsLive } from "../db/projects";
import { getSettings } from "../db/settings";
import type { Site } from "../db/sites";
import { ensureSeedSops, getTemplate } from "../db/sops";
import { insertTasks, listTasks, type NewTask } from "../db/tasks";
import { cleanText } from "../onboarding/templates";
import { zoneOf } from "../sop/cadence";
import { OWNER_LABEL } from "../sop/model";
import { SEED_SOPS } from "../sop/seeds";

// The `update_failed` incident and the CARE-5 fix task that goes with it (Plan 12). The incident sentence is one of a few fixed forms, filled only with values that were
// already checked (a slug and a page path from the stored run, a backup file name the result schema checked); nothing a client site or the helper said in free text gets in.

/** The CARE-5 checklist template: the four steps of an incident. It is never started as a project; its steps are the task's checklist. */
export const CARE_5_KEY = "CARE-5";

export const FAILED_SENTENCE = "update failed on the Mac helper";
const NO_BACKUP = "no backup file was recorded";
const MAX_SLUGS = 5;

const list = (slugs: string[]): string => {
  const shown = slugs.slice(0, MAX_SLUGS).join(", ");
  return slugs.length > MAX_SLUGS ? `${shown} +${slugs.length - MAX_SLUGS} more` : shown;
};

/** "updates rolled back: a, b broke /contact"; with no broken page named, "updates rolled back: a, b failed". */
export const rolledBackSentence = (slugs: string[], path: string | null): string => `updates rolled back: ${list(slugs)} ${path === null ? "failed" : `broke ${path}`}`;
/** "rollback failed for a: restore from siteline-backups/x.sql.gz". */
export const rollbackFailedSentence = (slugs: string[], backupFile: string | null): string => `rollback failed for ${list(slugs)}: ${backupFile ? `restore from ${backupFile}` : NO_BACKUP}`;

const SLUGS = "[A-Za-z0-9._, +-]{1,300}";
/** Every sentence an `update_failed` incident may carry. `incidentView` shows nothing else. */
export const UPDATE_DETAIL = new RegExp(
  `^(updates rolled back: ${SLUGS}( broke \\/[A-Za-z0-9._~\\/%-]{0,200}| failed)|rollback failed for ${SLUGS}: (restore from [A-Za-z0-9._\\/-]{1,300}|${NO_BACKUP})|${FAILED_SENTENCE})$`,
);

/** The booking zone's calendar date for `d` (YYYY-MM-DD). */
function dateIn(zone: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Opens the site's `update_failed` incident (one open at a time) with `why`, which must be one of the fixed sentences (anything else is replaced by the plain "update failed" one).
 * When the incident is new, also makes ONE CARE-5 task on the client's live Care project (none when it has no live Care project): owner Logan, "Fix: <domain> after updates",
 * the template's steps as the checklist, `periodKey` the incident's id, so a rerun of the same result adds none. A crash between the incident and the task is mended by the rerun,
 * which finds the incident opened after this run began and makes the task (the unique index keeps it to one).
 */
export async function openUpdateIncident(env: Env, run: CareRun, site: Site, why: string, now: Date): Promise<void> {
  const db = env.DB;
  const detail = UPDATE_DETAIL.test(why) ? why : FAILED_SENTENCE;
  const { incident, created } = await openIncident(db, { siteId: site.id, businessId: site.businessId, kind: "update_failed", detail, now: now.toISOString() });
  if (!created && incident.openedAt < run.createdAt) return;

  const project = (await listProjects(db, { businessId: site.businessId })).find((p) => p.kind === "care_onboarding" && projectIsLive(p));
  if (!project) {
    console.warn(`care: site ${site.id} has an update_failed incident but its client has no live Care project, so no fix task was made`);
    return;
  }
  let template = await getTemplate(db, CARE_5_KEY);
  if (!template) { await ensureSeedSops(db); template = await getTemplate(db, CARE_5_KEY); }
  const steps = template?.steps ?? SEED_SOPS.find((t) => t.key === CARE_5_KEY)!.steps;
  const tasks = await listTasks(db, project.id);
  const domain = site.domain ?? "client site";
  const task: NewTask = {
    projectId: project.id, businessId: site.businessId, isStep: false, stepKey: null, phaseKey: "incident", phaseTitle: "Incident", position: tasks.reduce((m, t) => Math.max(m, t.position), -1) + 1,
    title: cleanText(`Fix: ${domain} after updates`, 120), description: cleanText(`${detail}\nRun ${run.id.slice(0, 8)}.`, 2000), owner: "logan", status: "todo", doneWhen: "",
    estMinutes: steps.reduce((n, s) => n + s.estMinutes, 0), dueOn: dateIn(zoneOf(await getSettings(db)), now), billable: false, skippable: false, requires: [], milestone: null,
    clientSummary: null, docTemplate: null, emailTemplate: null, checklist: steps.map((s) => ({ text: `${s.title} (${OWNER_LABEL[s.owner]})`, done: false })),
    changeOrderId: null, cadenceKey: CARE_5_KEY, periodKey: incident.id,
  };
  await insertTasks(db, [task], { ignoreDuplicates: true });
}

/** Closes the site's open `update_failed` incident, if any. The fix task stays: it is Logan's to close. */
export async function closeUpdateIncident(env: Env, siteId: string, now: Date): Promise<void> {
  await closeIncident(env.DB, siteId, "update_failed", now.toISOString());
}
