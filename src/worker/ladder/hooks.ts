// Starts a client's retention ladder when their build finishes (Plan 15), and the backfill the daily sweep runs for any build whose hook never ran.
import { calendarDateIn } from "../billing/dates";
import { isTestClient, testClientSql } from "../clients/record";
import { insertLadderRows } from "../db/ladder";
import { getProject, type Project } from "../db/projects";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { onProjectDone } from "../projects/hooks";
import { zoneOf } from "../sop/cadence";
import { ladderRowsFor } from "./schedule";

const BACKFILL_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Registered with `onProjectDone`: when a real build project of a real client is done, the five dated steps are added, counted from the day it was done in the booking zone.
 * The project is read again, so only one that is really done counts. A replay adds nothing (a step is kept once per day). It never throws: a failure is logged.
 */
export async function ladderDoneHook(env: Env, p: Project): Promise<void> {
  try {
    if (p.kind !== "build" || p.test) return;
    const project = await getProject(env.DB, p.id);
    if (!project || project.status !== "done" || project.kind !== "build" || project.test) return;
    if (await isTestClient(env.DB, project.businessId)) return;
    const now = new Date();
    const launchOn = calendarDateIn(new Date(project.completedAt ?? now.toISOString()), zoneOf(await getSettings(env.DB)));
    await insertLadderRows(env.DB, ladderRowsFor(launchOn, { businessId: project.businessId, projectId: project.id }), now.toISOString());
  } catch (e) {
    console.error("ladder: could not add the steps for a finished build", e instanceof Error ? e.message : "unknown error");
  }
}

onProjectDone(ladderDoneHook);

/**
 * Adds the steps for every real build of a real client that was done in the last 180 days and has no ladder row, dated from the booking-zone day it was done.
 * Safe to run every day. Returns how many rows were new.
 */
export async function backfillLadder(env: Env, now: Date): Promise<number> {
  const since = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS).toISOString();
  const projects = (await env.DB.prepare(
    `SELECT p.id, p.business_id, p.completed_at FROM projects p JOIN businesses b ON b.id = p.business_id
     WHERE p.kind = 'build' AND p.status = 'done' AND p.test = 0 AND p.completed_at IS NOT NULL AND p.completed_at >= ? AND NOT ${testClientSql("b")}
       AND NOT EXISTS (SELECT 1 FROM ladder_steps l WHERE l.project_id = p.id)
     ORDER BY p.completed_at`,
  ).bind(since).all<{ id: string; business_id: string; completed_at: string }>()).results;
  if (projects.length === 0) return 0;
  const zone = zoneOf(await getSettings(env.DB));
  const rows = projects.flatMap((p) => ladderRowsFor(calendarDateIn(new Date(p.completed_at), zone), { businessId: p.business_id, projectId: p.id }));
  return insertLadderRows(env.DB, rows, now.toISOString());
}
