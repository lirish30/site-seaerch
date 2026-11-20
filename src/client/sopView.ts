import { SopTemplateInputSchema, validateTemplate, type SopStep, type SopTemplate, type SopTemplateInput } from "../worker/sop/model";
import type { Task } from "../worker/db/tasks";
import { parseDuration } from "./timeView";

/** Pure helpers for the SOP editor (Settings > SOPs) and the push-back from a project. No DOM, no fetch. The worker's own checks are used, so the sentences are the same ones the save gives. */

type Steps = Pick<SopTemplateInput, "steps">;

/** What is wrong with this template, as plain sentences, before the save: what the save would refuse about a field, then `validateTemplate`'s own sentences. Each once. Empty means it can be saved. */
export function templateProblems(t: SopTemplateInput): string[] {
  const out: string[] = [];
  const parsed = SopTemplateInputSchema.safeParse(t);
  if (!parsed.success) for (const i of parsed.error.issues) out.push(i.message);
  out.push(...validateTemplate(t));
  return [...new Set(out)];
}

export interface StepRow { phaseKey: string; phaseTitle: string; steps: SopStep[] }

const byPosition = (steps: SopStep[]): SopStep[] => steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position || a.i - b.i).map((x) => x.s);

/** The steps grouped by phase, phases in the order of their first step and steps in position order. */
export function stepRows(t: Steps): StepRow[] {
  const rows: StepRow[] = [];
  for (const s of byPosition(t.steps)) {
    let row = rows.find((r) => r.phaseKey === s.phaseKey);
    if (!row) { row = { phaseKey: s.phaseKey, phaseTitle: s.phaseTitle, steps: [] }; rows.push(row); }
    row.steps.push(s);
  }
  return rows;
}

/** The total of the estimates, said the way a person would: "about 42 hours". */
export function totalEstimate(t: Steps): string {
  const minutes = t.steps.reduce((n, s) => n + s.estMinutes, 0);
  if (minutes <= 0) return "no estimate yet";
  if (minutes < 60) return `about ${minutes} minutes`;
  const raw = minutes / 60;
  const hours = raw < 10 ? Math.round(raw * 2) / 2 : Math.round(raw);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Whether a step differs in anything the owner can edit. A new position number alone is not a change. */
function stepChanged(a: SopStep, b: SopStep): boolean {
  return a.phaseKey !== b.phaseKey || a.phaseTitle !== b.phaseTitle || a.title !== b.title || a.owner !== b.owner || a.estMinutes !== b.estMinutes || a.doneWhen !== b.doneWhen
    || a.docTemplate !== b.docTemplate || a.emailTemplate !== b.emailTemplate || a.milestone !== b.milestone || a.clientSummary !== b.clientSummary || a.skippable !== b.skippable
    || !sameList(a.requires, b.requires);
}

interface Diff { added: SopStep[]; removed: SopStep[]; changed: SopStep[]; reordered: boolean }

function diff(before: Pick<SopTemplate, "steps">, after: Steps): Diff {
  const was = new Map(before.steps.map((s) => [s.key, s]));
  const now = new Map(after.steps.map((s) => [s.key, s]));
  const added = after.steps.filter((s) => !was.has(s.key));
  const removed = before.steps.filter((s) => !now.has(s.key));
  const changed = after.steps.filter((s) => was.has(s.key) && stepChanged(was.get(s.key)!, s));
  const order = (steps: SopStep[], keep: Map<string, SopStep>) => byPosition(steps).filter((s) => keep.has(s.key)).map((s) => s.key).join("\u0000");
  return { added, removed, changed, reordered: order(before.steps, now) !== order(after.steps, was) };
}

/** What a push-back would change, as short phrases: "3 steps added", "1 removed", "2 changed". */
export function diffSummary(before: SopTemplate, after: SopTemplateInput): string[] {
  const d = diff(before, after);
  const counts: [number, string][] = [[d.added.length, "added"], [d.removed.length, "removed"], [d.changed.length, "changed"]];
  const out = counts.filter(([n]) => n > 0).map(([n, what], i) => `${n} ${i === 0 ? (n === 1 ? "step " : "steps ") : ""}${what}`);
  if (d.reordered) out.push("the order changed");
  return out.length ? out : ["no change to the steps"];
}

/** The steps behind those counts, by title, a few at a time: "Added: A, B", "Removed: C", "Changed: D". */
export function diffDetails(before: SopTemplate, after: SopTemplateInput): string[] {
  const d = diff(before, after);
  const names = (steps: SopStep[]) => (steps.length <= 3 ? steps.map((s) => s.title).join(", ") : `${steps.slice(0, 3).map((s) => s.title).join(", ")} and ${steps.length - 3} more`);
  return ([["Added", d.added], ["Removed", d.removed], ["Changed", d.changed]] as const).filter(([, steps]) => steps.length > 0).map(([label, steps]) => `${label}: ${names(steps)}`);
}

/** A project's step tasks as template steps: the client-side twin of the worker's `stepsFromTasks` (a test holds the two together). */
export function stepsFromTaskRows(tasks: Task[]): SopStep[] {
  return tasks
    .filter((t) => t.isStep && t.stepKey !== null)
    .sort((a, b) => a.position - b.position)
    .map((t) => ({
      key: t.stepKey!, phaseKey: t.phaseKey, phaseTitle: t.phaseTitle, position: t.position, title: t.title, owner: t.owner, estMinutes: t.estMinutes, doneWhen: t.doneWhen,
      docTemplate: t.docTemplate, emailTemplate: t.emailTemplate, requires: [...t.requires], milestone: t.milestone, clientSummary: t.clientSummary, skippable: t.skippable,
    }));
}

// ---------------------------------------------------------------- editing

/** The steps one step could wait on: every other step in the template. */
export const requiresChoices = (t: Steps, key: string): SopStep[] => byPosition(t.steps).filter((s) => s.key !== key);

const renumber = (steps: SopStep[]): SopStep[] => steps.map((s, i) => ({ ...s, position: i }));

/** The next free key in a phase: "1.3" after 1.1 and 1.2. */
export function nextStepKey(steps: SopStep[], phaseKey: string): string {
  const taken = new Set(steps.map((s) => s.key));
  const prefix = `${phaseKey}.`;
  let n = steps.reduce((m, s) => { const rest = s.key.startsWith(prefix) ? Number(s.key.slice(prefix.length)) : NaN; return Number.isInteger(rest) ? Math.max(m, rest) : m; }, 0) + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const newStep = (key: string, phaseKey: string, phaseTitle: string): SopStep => ({
  key, phaseKey, phaseTitle, position: 0, title: "New step", owner: "logan", estMinutes: 30, doneWhen: "", docTemplate: null, emailTemplate: null, requires: [], milestone: null, clientSummary: null, skippable: false,
});

/** A step added after the last one in its phase. */
export function addStep(steps: SopStep[], phaseKey: string): SopStep[] {
  const ordered = byPosition(steps);
  const last = ordered.map((s) => s.phaseKey).lastIndexOf(phaseKey);
  const title = ordered.find((s) => s.phaseKey === phaseKey)?.phaseTitle ?? "New phase";
  const step = newStep(nextStepKey(ordered, phaseKey), phaseKey, title);
  return renumber([...ordered.slice(0, last + 1), step, ...ordered.slice(last + 1)]);
}

/** A new phase at the end with one step in it. */
export function addPhase(steps: SopStep[]): SopStep[] {
  const used = new Set(steps.map((s) => s.phaseKey));
  let n = used.size + 1;
  while (used.has(String(n))) n++;
  const phaseKey = String(n);
  return renumber([...byPosition(steps), newStep(`${phaseKey}.1`, phaseKey, "New phase")]);
}

const withoutRequirements = (steps: SopStep[], gone: Set<string>): SopStep[] => steps.map((s) => (s.requires.some((r) => gone.has(r)) ? { ...s, requires: s.requires.filter((r) => !gone.has(r)) } : s));

/** A step removed; no other step waits on it afterwards. */
export function removeStep(steps: SopStep[], key: string): SopStep[] {
  return renumber(withoutRequirements(byPosition(steps).filter((s) => s.key !== key), new Set([key])));
}

/** A phase and its steps removed; no other step waits on any of them afterwards. */
export function removePhase(steps: SopStep[], phaseKey: string): SopStep[] {
  const gone = new Set(steps.filter((s) => s.phaseKey === phaseKey).map((s) => s.key));
  return renumber(withoutRequirements(byPosition(steps).filter((s) => s.phaseKey !== phaseKey), gone));
}

/** A step moved one place earlier (-1) or later (1) within its phase. At the edge nothing moves. */
export function moveStep(steps: SopStep[], key: string, dir: -1 | 1): SopStep[] {
  const ordered = byPosition(steps);
  const me = ordered.find((s) => s.key === key);
  if (!me) return renumber(ordered);
  const slots = ordered.map((s, i) => (s.phaseKey === me.phaseKey ? i : -1)).filter((i) => i >= 0);
  const at = slots.findIndex((i) => ordered[i].key === key);
  const to = at + dir;
  if (to < 0 || to >= slots.length) return renumber(ordered);
  const next = [...ordered];
  [next[slots[at]], next[slots[to]]] = [next[slots[to]], next[slots[at]]];
  return renumber(next);
}

/** A phase moved one place earlier (-1) or later (1), its steps with it. */
export function movePhase(steps: SopStep[], phaseKey: string, dir: -1 | 1): SopStep[] {
  const rows = stepRows({ steps });
  const at = rows.findIndex((r) => r.phaseKey === phaseKey);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= rows.length) return flattenPhases(rows);
  [rows[at], rows[to]] = [rows[to], rows[at]];
  return flattenPhases(rows);
}

/** A phase renamed on every one of its steps. */
export const setPhaseTitle = (steps: SopStep[], phaseKey: string, title: string): SopStep[] => steps.map((s) => (s.phaseKey === phaseKey ? { ...s, phaseTitle: title } : s));

/** The grouped phases back into one list of steps, each with the phase it sits in and positions that rise from zero. */
export function flattenPhases(rows: StepRow[]): SopStep[] {
  return renumber(rows.flatMap((r) => r.steps.map((s) => ({ ...s, phaseKey: r.phaseKey, phaseTitle: r.phaseTitle }))));
}

/** A step estimate typed as "45", "1h 30m" or "0": whole minutes from 0 to the 600 a step can have, or null. */
export function parseEstimate(text: string): number | null {
  const m = /^\s*0\s*(m|min|mins|minutes)?\s*$/i.test(text) ? 0 : parseDuration(text);
  return m !== null && m <= 600 ? m : null;
}
