import type { Task } from "../db/tasks";
import { unmetRequirements } from "./model";

/** The phases of a project in order, each by the position of its first step: phase 0 is the first one, and so on. Only steps count; ad-hoc and change-order tasks have no phase here. */
export function phaseOrder(tasks: Task[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const t of tasks) if (t.isStep && !(first.has(t.phaseKey) && first.get(t.phaseKey)! <= t.position)) first.set(t.phaseKey, t.position);
  const order = new Map<string, number>();
  [...first.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).forEach(([key], i) => order.set(key, i));
  return order;
}

/**
 * The project's current phase: the first phase (counted from 0, in step order) that has a step which is not done or skipped. Null when every step is finished,
 * or there are none. Tasks that are not steps never hold a phase open.
 */
export function currentPhase(tasks: Task[]): number | null {
  const order = phaseOrder(tasks);
  let lowest: number | null = null;
  for (const t of tasks) {
    if (!t.isStep || t.status === "done" || t.status === "skipped") continue;
    const p = order.get(t.phaseKey)!;
    if (lowest === null || p < lowest) lowest = p;
  }
  return lowest;
}

/**
 * The tasks Claude may be given now, in step order. Pure: the caller says whether the project is active and whether it is waiting on the client (neither is stored on the tasks).
 * A task is ready when Claude (or Claude drafting for Logan) owns it, it is still to do (a locked change-order task is not), every step it requires is satisfied, and its phase is the
 * project's current one or an earlier one. This is what keeps fifty Claude jobs from going out at once. A task that is not a step is not held back by phases.
 */
export function readyClaudeTasks(tasks: Task[], o: { projectActive: boolean; waiting: boolean }): Task[] {
  if (!o.projectActive || o.waiting) return [];
  const order = phaseOrder(tasks);
  const current = currentPhase(tasks);
  return tasks
    .filter((t) => (t.owner === "claude" || t.owner === "claude_drafts") && t.status === "todo")
    .filter((t) => unmetRequirements(t.requires, tasks).length === 0)
    .filter((t) => !t.isStep || current === null || order.get(t.phaseKey)! <= current)
    .sort((a, b) => a.position - b.position);
}
