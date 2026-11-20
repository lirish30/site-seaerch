import type { Project } from "../db/projects";
import type { Env } from "../env";
import type { MilestoneKey } from "../sop/model";

/**
 * What other features want to know about a project. Each is registered once at start-up (Claude dispatch and Care follow-ups, and invoicing in Plan 8)
 * and run by the task service. A hook that fails is logged and skipped: the change that triggered it has already been saved and is never undone.
 */
type DoneHook = (env: Env, p: Project) => Promise<void>;
type MilestoneHook = (env: Env, p: Project, m: MilestoneKey) => Promise<void>;
type ChangedHook = (env: Env, projectId: string) => Promise<void>;

const done: DoneHook[] = [];
const milestone: MilestoneHook[] = [];
const changed: ChangedHook[] = [];

/** Runs when a project finishes (once, whatever the number of requests that finished it). */
export function onProjectDone(fn: DoneHook): void { done.push(fn); }
/** Runs the first time a project reaches a milestone. */
export function onMilestone(fn: MilestoneHook): void { milestone.push(fn); }
/** Runs after a task is finished, skipped, reopened or added, or has its owner or requirements changed: what is ready to start may have changed. */
export function onTasksChanged(fn: ChangedHook): void { changed.push(fn); }

/** Runs every hook in the order registered (those registered while running wait for the next time). One that throws is logged and the rest still run. */
async function runAll<A extends unknown[]>(label: string, hooks: ((env: Env, ...a: A) => Promise<void>)[], env: Env, ...args: A): Promise<void> {
  for (const h of [...hooks]) {
    try { await h(env, ...args); }
    catch (e) { console.error(`projects: a ${label} hook failed`, e instanceof Error ? e.message : "unknown error"); }
  }
}

export const runProjectDone = (env: Env, p: Project): Promise<void> => runAll("project-done", done, env, p);
export const runMilestone = (env: Env, p: Project, m: MilestoneKey): Promise<void> => runAll("milestone", milestone, env, p, m);
export const runTasksChanged = (env: Env, projectId: string): Promise<void> => runAll("tasks-changed", changed, env, projectId);

/** For tests: forgets every registered hook. */
export function clearProjectHooksForTests(): void {
  done.length = 0;
  milestone.length = 0;
  changed.length = 0;
}
