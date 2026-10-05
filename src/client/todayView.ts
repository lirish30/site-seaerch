import { ApiError } from "./api";
import type { TodayItem, TodayKind } from "./types";

export const TODAY_KIND_LABEL: Record<TodayKind, string> = {
  follow_up_due: "Follow-up", draft_unsent: "Unsent draft", stalled_deal: "Stalled deal", promising_quick_scan: "Promising",
};

/** The Snooze buttons, in days. The API accepts 1 to 30. */
export const SNOOZE_DAYS = [1, 3, 7] as const;

/** "Due Oct 1, 2026", or null for items with no due date. A follow-up is a calendar date, so it is read in UTC to avoid shifting a day. */
export function dueLabel(due: string | null): string | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return null;
  return `Due ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

export const snoozeButtonLabel = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
/** Per-row accessible names so a screen reader can tell the buttons apart. */
export const doneLabel = (name: string) => `Mark done: ${name}`;
export const snoozeLabel = (name: string, days: number) => `Snooze ${name} for ${snoozeButtonLabel(days)}`;

/** Inline text for a failed Done or Snooze: the API's own message, or a generic fallback. */
export function actionErrorText(x: unknown, what: "done" | "snooze"): string {
  return x instanceof ApiError ? x.message : what === "done" ? "Couldn't mark that done." : "Couldn't snooze that.";
}

/** The list without one item. Returns the same array when the id is not in it. */
export function withoutItem(items: readonly TodayItem[], id: string): TodayItem[] {
  return items.some((i) => i.id === id) ? items.filter((i) => i.id !== id) : (items as TodayItem[]);
}

export const actionPath = (item: Pick<TodayItem, "kind" | "businessId">, action: "done" | "snooze") =>
  `/today/${item.kind}/${encodeURIComponent(item.businessId)}/${action}`;
