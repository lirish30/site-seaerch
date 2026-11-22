import { projectIsLive, SEO_ONBOARDING_KEY, type Project, type ProjectKind, type ProjectStatus } from "../worker/db/projects";
import type { Task } from "../worker/db/tasks";
import type { MilestoneKey, OwnerTag } from "../worker/sop/model";

/** Pure helpers for the owner's Projects pages. No DOM, no fetch, no clock of its own. Types only come from the worker, so no worker code is bundled. */

export type Tone = "neutral" | "good" | "warn" | "muted";

const isClosed = (t: Pick<Task, "status">) => t.status === "done" || t.status === "skipped";

export interface PhaseGroup { phaseKey: string; title: string; tasks: Task[]; done: number; total: number }

/** The tasks grouped by phase, phases in the order of their first task and tasks in position order. Extra tasks and change-order tasks are their own groups (they carry a phase of their own). Done counts done and skipped. */
export function phaseGroups(tasks: Task[]): PhaseGroup[] {
  const groups = new Map<string, PhaseGroup & { first: number }>();
  for (const t of tasks) {
    let g = groups.get(t.phaseKey);
    if (!g) { g = { phaseKey: t.phaseKey, title: t.phaseTitle, tasks: [], done: 0, total: 0, first: t.position }; groups.set(t.phaseKey, g); }
    g.first = Math.min(g.first, t.position);
    g.tasks.push(t);
    g.total++;
    if (isClosed(t)) g.done++;
  }
  return [...groups.values()]
    .sort((a, b) => a.first - b.first || a.phaseKey.localeCompare(b.phaseKey))
    .map(({ first: _first, ...g }) => ({ ...g, tasks: [...g.tasks].sort((a, b) => a.position - b.position) }));
}

/** The requirements of `t` that are still open: a done step satisfies, a skipped one only when it is marked skippable. Each is the step's key and its title (a key with no task is both). */
function openRequirements(t: Pick<Task, "requires">, all: Pick<Task, "stepKey" | "title" | "status" | "skippable">[]): { key: string; title: string }[] {
  const out: { key: string; title: string }[] = [];
  for (const key of t.requires) {
    const dep = all.find((x) => x.stepKey === key);
    if (!dep) { out.push({ key, title: key }); continue; }
    if (dep.status === "done" || (dep.status === "skipped" && dep.skippable)) continue;
    out.push({ key, title: dep.title });
  }
  return out;
}

/** "a, b, c" for up to three, then "a, b, c and 2 more". */
const keyList = (keys: string[]) => (keys.length <= 3 ? keys.join(", ") : `${keys.slice(0, 3).join(", ")} and ${keys.length - 3} more`);

/** What to say about a task. `blockedBy` holds the titles of the open requirements (what the server's 409 names too). Only a task still to do can be blocked. */
export function taskState(t: Task, all: Task[]): { label: string; tone: Tone; blockedBy: string[] } {
  const none: string[] = [];
  switch (t.status) {
    case "done": return { label: "Done", tone: "good", blockedBy: none };
    case "skipped": return { label: "Skipped", tone: "muted", blockedBy: none };
    case "locked": return { label: "Locked: change order unpaid", tone: "warn", blockedBy: none };
    case "waiting_client": return { label: "Waiting on client", tone: "muted", blockedBy: none };
    case "in_review": return { label: "In review", tone: "warn", blockedBy: none };
    case "in_progress": return { label: "In progress", tone: "neutral", blockedBy: none };
    case "todo": {
      const open = openRequirements(t, all);
      if (open.length) return { label: `Blocked by ${keyList(open.map((o) => o.key))}`, tone: "warn", blockedBy: open.map((o) => o.title) };
      return { label: "Ready", tone: "neutral", blockedBy: none };
    }
  }
}

const OWNER: Record<OwnerTag, string> = { claude: "Claude", logan: "Logan", claude_drafts: "Claude drafts" };
/** Who does the step, short enough for a badge (Claude drafts it and Logan approves). */
export const ownerBadge = (o: OwnerTag): string => OWNER[o];

/** Steps done or skipped out of all steps. A project with no steps (only tasks added by hand) counts every task instead. */
export function projectProgress(tasks: Pick<Task, "isStep" | "status">[]): { done: number; total: number; pct: number } {
  const steps = tasks.filter((t) => t.isStep);
  const counted = steps.length ? steps : tasks;
  const done = counted.filter(isClosed).length;
  return { done, total: counted.length, pct: counted.length ? Math.round((done / counted.length) * 100) : 0 };
}

const MILESTONES: { key: MilestoneKey; label: string }[] = [{ key: "design_approved", label: "Design approved" }, { key: "site_finished", label: "Site finished" }];

/** Both milestones, each with whether the project has reached it (and when). */
export function milestoneChips(reached: { milestone: MilestoneKey; reachedAt: string }[]): { key: MilestoneKey; label: string; reached: boolean; reachedAt: string | null }[] {
  return MILESTONES.map((m) => {
    const hit = reached.find((r) => r.milestone === m.key);
    return { key: m.key, label: m.label, reached: !!hit, reachedAt: hit?.reachedAt ?? null };
  });
}

/** Whole dollars from cents with a minus before the dollar sign: -4000 -> "-$40". */
const money = (cents: number): string => {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: abs % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
};

export interface ProfitData { soldCents: number; paidCents: number; costCents: number; marginSoldCents: number; marginPaidCents: number; effectiveHourlyCents: number | null }

/** The profit card as lines of text. With no cost rate set it says so instead of showing a margin that equals the money paid; with a rate but no time yet the cost is $0. */
export function profitLines(p: ProfitData, costRateCentsPerHour: number): string[] {
  const sold = `Sold ${money(p.soldCents)}`;
  if (costRateCentsPerHour === 0) return [sold, `Paid ${money(p.paidCents)}`, "Cost rate not set"];
  const hourly = p.effectiveHourlyCents === null ? "no time logged yet" : `about ${money(p.effectiveHourlyCents)} an hour`;
  return [sold, `Paid ${money(p.paidCents)}, cost ${money(p.costCents)}, margin ${money(p.marginPaidCents)}, ${hourly}`];
}

export type Bucket = "active" | "waiting" | "paused" | "done";

type StateOf = { status: ProjectStatus; kind: ProjectKind; templateKey: string | null; waitingOnClient: boolean };

/**
 * The state chip on a project. A project waiting on its client is still active, but says so. A finished Care onboarding project is the client's ongoing Care service (it is live:
 * its weekly and monthly work keeps being made and sent to Claude), so it says that instead of "Done"; a finished SEO-0 project is the client's Local SEO service, and says so.
 */
export function projectState(p: StateOf): { label: string; tone: Tone } {
  if (p.status === "paused") return { label: "Paused", tone: "warn" };
  if (p.status === "done") return projectIsLive(p) ? { label: p.templateKey === SEO_ONBOARDING_KEY ? "Local SEO running" : "Care running", tone: "good" } : { label: "Done", tone: "good" };
  if (p.status === "cancelled") return { label: "Cancelled", tone: "muted" };
  return p.waitingOnClient ? { label: "Waiting on client", tone: "muted" } : { label: "Active", tone: "neutral" };
}

/** Which sidebar list a project is in: cancelled sits with done, and a live (finished) Care or Local SEO project sits with active. */
export function projectBucket(p: StateOf): Bucket {
  if (p.status === "paused") return "paused";
  if (p.status === "cancelled" || (p.status === "done" && !projectIsLive(p))) return "done";
  return p.waitingOnClient ? "waiting" : "active";
}

export function bucketCounts(rows: StateOf[]): Record<Bucket, number> {
  const out: Record<Bucket, number> = { active: 0, waiting: 0, paused: 0, done: 0 };
  for (const r of rows) out[projectBucket(r)]++;
  return out;
}

/** The rows the projects page shows: one lead's projects whatever their state (the Today link goes there), else the view's own list. */
export function visibleProjects<T extends StateOf & { businessId: string }>(rows: T[], o: { view: Bucket; businessId: string | null }): T[] {
  return o.businessId ? rows.filter((r) => r.businessId === o.businessId) : rows.filter((r) => projectBucket(r) === o.view);
}

/** What the project page offers for stopping work. Only a Care or Local SEO project that is finished and running can be cancelled alone: that stops its service (its cadences and Claude dispatch), and only that one. */
export type CancelMode = "project" | "care" | "seo";
export function stopControls(p: { status: ProjectStatus; kind: ProjectKind; templateKey: string | null }): { pause: boolean; resume: boolean; cancel: CancelMode | null } {
  if (p.status === "active") return { pause: true, resume: false, cancel: "project" };
  if (p.status === "paused") return { pause: false, resume: true, cancel: "project" };
  if (p.status === "done" && projectIsLive(p)) return { pause: false, resume: false, cancel: p.templateKey === SEO_ONBOARDING_KEY ? "seo" : "care" };
  return { pause: false, resume: false, cancel: null };
}
export const cancelLabel = (mode: CancelMode): string => (mode === "care" ? "Stop Care (cancel project)" : mode === "seo" ? "Stop Local SEO (cancel project)" : "Cancel project");
export const cancelConfirm = (name: string, mode: CancelMode): string =>
  mode === "care"
    ? `Cancel "${name}"? This stops the client's Care service: its weekly and monthly tasks stop being made and nothing more goes to Claude. It cannot be reopened.`
    : mode === "seo"
      ? `Cancel "${name}"? This stops this client's monthly Local SEO tasks (and the quarterly and yearly ones) and nothing more goes to Claude for them. It does not touch Care. It cannot be reopened.`
      : `Cancel "${name}"? Its open Claude steps stop and nothing more is done on it. It cannot be reopened.`;

/** A change order can be drafted on any project that is not cancelled: a launched site still needs extra work. */
export const canTakeChangeOrder = (status: ProjectStatus): boolean => status !== "cancelled";

/** Whether the project's steps can be edited: while it is paused or live (active, or a finished Care or Local SEO service). */
export const stepsEditable = (p: { status: ProjectStatus; kind: ProjectKind; templateKey: string | null }): boolean => p.status === "paused" || projectIsLive(p);

const KIND: Record<ProjectKind, string> = { build: "Site build", quick_fix: "Quick fix", care_onboarding: "Care setup", custom: "Custom" };
export const kindLabel = (k: ProjectKind): string => KIND[k];

/** The sentence for a 409 that names the steps in the way ("Blocked by: a, b"), or null when the body names none. */
export function blockedText(body: unknown): string | null {
  const list = body && typeof body === "object" ? (body as { blockedBy?: unknown }).blockedBy : undefined;
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === "string")) return null;
  return `Blocked by: ${list.join(", ")}`;
}

/** The projects that came from one deal. */
export const dealProjects = <T extends Pick<Project, "dealId">>(projects: T[], dealId: string): T[] => projects.filter((p) => p.dealId === dealId);

/** The progress a project card shows, from the counts GET /projects gives: steps only, as on the project page, or every task when the project has no steps. */
export function listProgress(p: { openSteps: number; doneSteps: number; openTasks: number; doneTasks: number }): { done: number; total: number; pct: number } {
  const steps = p.openSteps + p.doneSteps;
  const done = steps ? p.doneSteps : p.doneTasks;
  const total = steps ? steps : p.openTasks + p.doneTasks;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** The tasks that have time logged, in the order given. */
export const timeRows = (tasks: Task[], minutes: Record<string, number>): Task[] => tasks.filter((t) => (minutes[t.id] ?? 0) > 0);

/** The estimate to hold the time logged against: only tasks that have been started, finished or timed, so work not begun does not make the project look under. Skipped tasks never count. */
export function timeEstimate(tasks: Task[], minutes: Record<string, number>): number {
  return tasks.filter((t) => t.status !== "skipped" && (t.startedAt !== null || t.status === "done" || (minutes[t.id] ?? 0) > 0)).reduce((n, t) => n + t.estMinutes, 0);
}

/**
 * Which start buttons a deal's page offers. "Start projects" is the retry for a won deal that has none (the paid deposit normally starts them). "Start a test project" is
 * for a deal whose latest signed proposal (the list is newest first) is a test copy. A deal that already has a project is offered neither.
 */
export function startOffers(deal: { stage: string }, docs: { status: string; test: boolean }[], projects: unknown[]): { canStart: boolean; canStartTest: boolean } {
  if (projects.length > 0) return { canStart: false, canStartTest: false };
  const latestSigned = docs.find((d) => d.status === "signed");
  return { canStart: deal.stage === "won", canStartTest: !!latestSigned && latestSigned.test };
}
