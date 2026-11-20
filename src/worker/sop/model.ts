import { z } from "zod";
import { PACKAGE_KEYS, type PackageKey } from "../db/packages";

/** Who does a step. `claude_drafts` means Claude prepares it and Logan approves before anything leaves. */
export const OWNER_TAGS = ["claude", "logan", "claude_drafts"] as const;
export type OwnerTag = (typeof OWNER_TAGS)[number];
export const OWNER_LABEL: Record<OwnerTag, string> = {
  claude: "Claude",
  logan: "Logan",
  claude_drafts: "Claude drafts → Logan approves",
};

export const CADENCES = ["weekly", "monthly", "quarterly", "annual"] as const;
export type Cadence = (typeof CADENCES)[number];

export const MILESTONE_KEYS = ["design_approved", "site_finished"] as const;
export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "waiting_client", "done", "skipped", "locked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface SopStep {
  key: string;
  phaseKey: string;
  phaseTitle: string;
  position: number;
  title: string;
  owner: OwnerTag;
  estMinutes: number;
  doneWhen: string;
  docTemplate: string | null;
  emailTemplate: string | null;
  requires: string[];
  milestone: MilestoneKey | null;
  clientSummary: string | null;
  skippable: boolean;
}

export interface SopTemplate {
  id: string;
  key: string;
  name: string;
  kind: "project" | "recurring";
  cadence: Cadence | null;
  /** ISO weekday (1 = Monday to 7 = Sunday) for a weekly cadence, day of the month (1 to 28) for the others. */
  cadenceDay: number | null;
  appliesTo: PackageKey[];
  version: number;
  active: boolean;
  steps: SopStep[];
  updatedAt: string;
}
export type SopTemplateInput = Omit<SopTemplate, "id" | "version" | "updatedAt">;

const KEY = /^[A-Za-z0-9._-]{1,20}$/;
const keyMsg = "must be 1 to 20 letters, digits, dots, dashes or underscores";

const StepSchema = z.object({
  key: z.string().regex(KEY, `A step key ${keyMsg}.`),
  phaseKey: z.string().regex(KEY, `A phase key ${keyMsg}.`),
  phaseTitle: z.string().min(1, "A phase needs a title.").max(80, "A phase title is at most 80 characters."),
  position: z.number().int("A step position must be a whole number.").min(0, "A step position cannot be negative."),
  title: z.string().min(1, "A step needs a title.").max(120, "A step title is at most 120 characters."),
  owner: z.enum(OWNER_TAGS, "A step owner must be Claude, Logan, or Claude drafts."),
  estMinutes: z.number().int("A step estimate must be whole minutes.").min(0, "A step estimate cannot be negative.").max(600, "A step estimate is at most 600 minutes."),
  doneWhen: z.string().max(300, "A done-when is at most 300 characters."),
  docTemplate: z.string().min(1).max(80).nullable(),
  emailTemplate: z.string().min(1).max(80).nullable(),
  requires: z.array(z.string().max(20)).max(60, "A step can wait on at most 60 other steps."),
  milestone: z.enum(MILESTONE_KEYS).nullable(),
  clientSummary: z.string().min(1).max(80, "A client summary is at most 80 characters.").nullable(),
  skippable: z.boolean(),
});

export const SopTemplateInputSchema = z.object({
  key: z.string().regex(KEY, `A template key ${keyMsg}.`),
  name: z.string().min(1, "A template needs a name.").max(80, "A template name is at most 80 characters."),
  kind: z.enum(["project", "recurring"]),
  cadence: z.enum(CADENCES).nullable(),
  cadenceDay: z.number().int().nullable(),
  appliesTo: z.array(z.enum(PACKAGE_KEYS)),
  active: z.boolean(),
  steps: z.array(StepSchema).max(120, "A template has at most 120 steps."),
}).superRefine((t, ctx) => {
  for (const msg of cadenceProblems(t)) ctx.addIssue({ code: "custom", message: msg, path: ["cadence"] });
});

/** What is wrong with the cadence fields, as plain sentences. */
function cadenceProblems(t: Pick<SopTemplateInput, "kind" | "cadence" | "cadenceDay">): string[] {
  const out: string[] = [];
  if (t.kind === "recurring") {
    if (!t.cadence) { out.push("A recurring template needs a cadence (weekly, monthly, quarterly or annual)."); return out; }
    if (t.cadence === "weekly") {
      if (t.cadenceDay === null || t.cadenceDay < 1 || t.cadenceDay > 7) out.push("A weekly template needs a weekday from 1 (Monday) to 7 (Sunday).");
    } else if (t.cadence === "monthly") {
      if (t.cadenceDay === null || t.cadenceDay < 1 || t.cadenceDay > 28) out.push("A monthly template needs a day of the month from 1 to 28.");
    } else if (t.cadenceDay !== null && (t.cadenceDay < 1 || t.cadenceDay > 28)) {
      out.push("The day of the month must be from 1 to 28.");
    }
  } else {
    if (t.cadence !== null) out.push("Only a recurring template has a cadence.");
    if (t.cadenceDay !== null) out.push("Only a recurring template has a cadence day.");
  }
  return out;
}

/** What is wrong with this template, as plain sentences. An empty list means it can be saved. */
export function validateTemplate(t: SopTemplateInput): string[] {
  const problems = [...cadenceProblems(t)];
  const keys = new Set<string>();
  for (const s of t.steps) {
    if (keys.has(s.key)) problems.push(`The step key ${s.key} is used twice.`);
    keys.add(s.key);
  }

  const graph = new Map<string, string[]>();
  for (const s of t.steps) {
    if (graph.has(s.key)) continue; // a duplicate key was reported above; its first definition wins here
    const edges: string[] = [];
    for (const r of s.requires) {
      if (r === s.key) problems.push(`Step ${s.key} requires itself.`);
      else if (!keys.has(r)) problems.push(`Step ${s.key} requires ${r}, which is not a step in this template.`);
      else edges.push(r);
    }
    graph.set(s.key, edges);
  }
  const cycle = findCycle(graph);
  if (cycle) problems.push(`Steps wait on each other in a loop: ${cycle.join(" → ")}.`);

  const byMilestone = new Map<MilestoneKey, string[]>();
  for (const s of t.steps) if (s.milestone) byMilestone.set(s.milestone, [...(byMilestone.get(s.milestone) ?? []), s.key]);
  for (const [m, on] of byMilestone) {
    if (t.kind === "recurring") problems.push(`A recurring template cannot have a milestone (${m} is on step ${on[0]}).`);
    else if (on.length > 1) problems.push(`The milestone ${m} is on more than one step (${on.join(", ")}).`);
  }

  for (let i = 1; i < t.steps.length; i++) {
    if (t.steps[i].position <= t.steps[i - 1].position) {
      problems.push(`Step ${t.steps[i].key} comes after step ${t.steps[i - 1].key} but does not have a higher position.`);
    }
  }
  return problems;
}

/** The first dependency loop found, as the keys around it (first key repeated at the end), or null. */
export function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = finished
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    state.set(k, 1);
    path.push(k);
    for (const next of graph.get(k) ?? []) {
      const st = state.get(next);
      if (st === 1) return [...path.slice(path.indexOf(next)), next];
      if (st === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of graph.keys()) {
    if (state.has(k)) continue;
    const found = visit(k);
    if (found) return found;
  }
  return null;
}

/**
 * The titles of the steps in `requires` that are not yet satisfied. A done task satisfies; a skipped one only when it is marked skippable.
 * A key with no task is unmet and is named by the key itself.
 */
export function unmetRequirements(
  requires: string[],
  tasks: { stepKey: string | null; title: string; status: TaskStatus; skippable: boolean }[],
): string[] {
  const byKey = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) if (t.stepKey !== null && !byKey.has(t.stepKey)) byKey.set(t.stepKey, t);
  const out: string[] = [];
  for (const key of requires) {
    const t = byKey.get(key);
    if (!t) { out.push(key); continue; }
    if (t.status === "done" || (t.status === "skipped" && t.skippable)) continue;
    out.push(t.title);
  }
  return out;
}
