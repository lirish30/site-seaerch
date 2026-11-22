import type { BatchGroup, BatchTask } from "../worker/batches/groups";
import type { TaskStatus } from "../worker/sop/model";

/** "4 h 20 m", "45 m", "2 h": minutes as hours and minutes, for how much work is left. */
export function minutesText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60), r = m % 60;
  return h === 0 ? `${r} m` : r === 0 ? `${h} h` : `${h} h ${r} m`;
}

/** "3 of 11 done, about 4 h 20 m left", or "All 11 done" when nothing is open. A skipped task is in neither number. */
export function progressLine(g: Pick<BatchGroup, "open" | "done" | "estMinutes">): string {
  const total = g.open + g.done;
  if (total === 0) return "Nothing to do";
  if (g.open === 0) return `All ${total} done`;
  return `${g.done} of ${total} done, about ${minutesText(g.estMinutes)} left`;
}

/** The share of the batch that is done, 0 to 100, for the meter. */
export const donePercent = (g: Pick<BatchGroup, "open" | "done">): number => (g.open + g.done === 0 ? 0 : Math.round((g.done / (g.open + g.done)) * 100));

/** A task still to do: not done and not skipped. */
export const isOpenTask = (t: Pick<BatchTask, "status">): boolean => t.status !== "done" && t.status !== "skipped";

/** The first open task in the order shown that is not a held client's (a hold stops the work, so "Work through" does not start there), or null. */
export const firstOpenTask = (g: Pick<BatchGroup, "tasks">): BatchTask | null => g.tasks.find((t) => isOpenTask(t) && !t.held) ?? null;

/** Where "Work through" goes: the first open task's page, or null when there is nothing to start. */
export const workThroughHref = (g: Pick<BatchGroup, "tasks">): string | null => {
  const t = firstOpenTask(g);
  return t ? `/tasks/${encodeURIComponent(t.taskId)}` : null;
};

const STATUS_WORDS: Record<TaskStatus, string> = {
  todo: "To do", in_progress: "In progress", in_review: "In review", waiting_client: "Waiting on client", done: "Done", skipped: "Skipped", locked: "Locked",
};
export const statusWords = (s: TaskStatus): string => STATUS_WORDS[s];
export const statusTone = (s: TaskStatus): "" | "positive" | "info" | "warning" => (s === "done" ? "positive" : s === "in_progress" || s === "in_review" ? "info" : s === "waiting_client" ? "warning" : "");

/** "Wed, Nov 18" from `YYYY-MM-DD` (a date with no zone in it), or "No due date". */
export function dueText(dueOn: string | null): string {
  if (!dueOn) return "No due date";
  const [y, m, d] = dueOn.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** A batch is late when its due date has passed (today is a local `YYYY-MM-DD`) and something is still open. */
export const isLate = (g: Pick<BatchGroup, "dueOn" | "open">, today: string): boolean => g.open > 0 && g.dueOn !== null && g.dueOn < today;

/** "2 of 5 steps" on a task row, or null when the task has no checklist. */
export const checklistText = (t: Pick<BatchTask, "checklistDone" | "checklistTotal">): string | null =>
  t.checklistTotal === 0 ? null : `${t.checklistDone} of ${t.checklistTotal} ${t.checklistTotal === 1 ? "step" : "steps"}`;
