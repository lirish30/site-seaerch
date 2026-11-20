import type { Project, ProjectKind, ProjectStatus } from "../worker/db/projects";
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

/** The profit card as lines of text. No cost (no cost rate in Settings, or no time yet) says so instead of showing a margin that equals the money paid. */
export function profitLines(p: ProfitData): string[] {
  const sold = `Sold ${money(p.soldCents)}`;
  if (p.costCents === 0) return [sold, `Paid ${money(p.paidCents)}`, "Cost rate not set"];
  const hourly = p.effectiveHourlyCents === null ? "no time logged yet" : `about ${money(p.effectiveHourlyCents)} an hour`;
  return [sold, `Paid ${money(p.paidCents)}, cost ${money(p.costCents)}, margin ${money(p.marginPaidCents)}, ${hourly}`];
}

export type Bucket = "active" | "waiting" | "paused" | "done";

/** The state chip on a project. A project waiting on its client is still active, but says so. */
export function projectState(p: { status: ProjectStatus; waitingOnClient: boolean }): { label: string; tone: Tone } {
  if (p.status === "paused") return { label: "Paused", tone: "warn" };
  if (p.status === "done") return { label: "Done", tone: "good" };
  if (p.status === "cancelled") return { label: "Cancelled", tone: "muted" };
  return p.waitingOnClient ? { label: "Waiting on client", tone: "muted" } : { label: "Active", tone: "neutral" };
}

/** Which sidebar list a project is in: cancelled sits with done. */
export function projectBucket(p: { status: ProjectStatus; waitingOnClient: boolean }): Bucket {
  if (p.status === "paused") return "paused";
  if (p.status === "done" || p.status === "cancelled") return "done";
  return p.waitingOnClient ? "waiting" : "active";
}

export function bucketCounts(rows: { status: ProjectStatus; waitingOnClient: boolean }[]): Record<Bucket, number> {
  const out: Record<Bucket, number> = { active: 0, waiting: 0, paused: 0, done: 0 };
  for (const r of rows) out[projectBucket(r)]++;
  return out;
}

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

const CO_LABEL: Record<"draft" | "sent" | "viewed" | "declined" | "void" | "expired", string> = { draft: "Draft", sent: "Sent", viewed: "Viewed", declined: "Declined", void: "Void", expired: "Expired" };

/** The chip on a change order. A signed one is "Signed, unpaid" (its tasks stay locked) until it is paid. */
export function changeOrderChip(co: { status: "draft" | "sent" | "viewed" | "signed" | "declined" | "void" | "expired"; paidAt: string | null }): { label: string; tone: Tone } {
  if (co.status === "signed") return co.paidAt ? { label: "Paid", tone: "good" } : { label: "Signed, unpaid", tone: "warn" };
  return { label: CO_LABEL[co.status], tone: co.status === "draft" || co.status === "sent" || co.status === "viewed" ? "neutral" : "muted" };
}
