import { ApiError } from "./api";
import type { OwnerChangeOrder } from "../worker/changeorders/service";
import type { Project } from "../worker/db/projects";
import type { Task, TaskComment } from "../worker/db/tasks";
import type { TimeEntry } from "../worker/db/time";
import type { MilestoneKey } from "../worker/sop/model";
import type { WeekGrid } from "../worker/time/service";
import { blockedText, type ProfitData } from "./projectView";

/** The shapes of the owner routes the Projects pages call (Task 9's route table). Types only; nothing from the worker is bundled. */

export interface ProjectRow extends Project { businessName: string; openTasks: number; doneTasks: number; waitingOnClient: boolean }

export interface ProjectDetail {
  project: Project;
  tasks: Task[];
  taskMinutes: Record<string, number>;
  milestones: { milestone: MilestoneKey; reachedAt: string }[];
  time: { actualMinutes: number; billableMinutes: number };
  profit: ProfitData;
  waitingOnClient: boolean;
  changeOrders: OwnerChangeOrder[];
  template: { key: string; name: string; version: number } | null;
}

export interface TaskDetail { task: Task; comments: TaskComment[]; time: { actualMinutes: number; billableMinutes: number; entries: TimeEntry[] } }

export interface MyTasks { projects: { projectId: string; projectName: string; businessId: string; businessName: string; test: boolean; tasks: Task[] }[] }

export type RunningEntry = TimeEntry & { taskTitle: string; projectName: string };

export type Week = WeekGrid & { tz: string; weekStartsOn: 0 | 1 };

/** Fired after the timer starts or stops, so the rail widget and any open page re-read it. */
export const TIMER_CHANGED = "timer:changed";
export const announceTimerChanged = () => window.dispatchEvent(new Event(TIMER_CHANGED));
/** Fired after a project is paused, resumed or cancelled, so the sidebar's counts refresh. */
export const PROJECTS_CHANGED = "projects:changed";
export const announceProjectsChanged = () => window.dispatchEvent(new Event(PROJECTS_CHANGED));

/** What to tell the owner when a call failed: the steps in the way when the server says so, else the server's own sentence. */
export function workError(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof ApiError) return blockedText(e.body) ?? e.message;
  return e instanceof Error ? e.message : fallback;
}
