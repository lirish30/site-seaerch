import { ApiError } from "./api";
import type { IconName } from "./components/iconMarkup";
import type { TodayItem, TodayKind } from "./types";

export const TODAY_KIND_LABEL: Record<TodayKind, string> = {
  follow_up_due: "Follow-up", draft_unsent: "Unsent draft", stalled_deal: "Stalled deal", starred_idle: "Saved", promising_quick_scan: "Promising",
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

// ---- Home "Up next" rows ----

export type KindFilter = "all" | TodayKind;
/** What each kind looks like on a Home row: its label, icon tile, the filter pill it is counted under and the main action. */
export const KIND_VIEW: Record<TodayKind, { label: string; icon: IconName; tone: "critical" | "info" | "warning" | "signal" | "neutral"; pill: string; action: string }> = {
  follow_up_due: { label: "Follow-up", icon: "clock", tone: "critical", pill: "Follow-ups", action: "Open" },
  draft_unsent: { label: "Unsent draft", icon: "mail", tone: "info", pill: "Drafts", action: "Review draft" },
  stalled_deal: { label: "Stalled deal", icon: "trending", tone: "warning", pill: "Deals", action: "Open" },
  promising_quick_scan: { label: "Worth a full scan", icon: "sparkles", tone: "signal", pill: "Scans", action: "Run full scan" },
  starred_idle: { label: "Saved", icon: "star", tone: "neutral", pill: "Saved", action: "Open" },
};
/** The filter pills in display order. "Saved" only shows when there is something saved, so the row matches the design for everyone else. */
export const FILTER_ORDER: TodayKind[] = ["follow_up_due", "draft_unsent", "stalled_deal", "promising_quick_scan", "starred_idle"];

export function filterPills(items: readonly TodayItem[]): { key: KindFilter; label: string; count: number }[] {
  const count = (k: TodayKind) => items.filter((i) => i.kind === k).length;
  return [{ key: "all", label: "All", count: items.length },
    ...FILTER_ORDER.filter((k) => k !== "starred_idle" || count(k) > 0).map((k) => ({ key: k as KindFilter, label: KIND_VIEW[k].pill, count: count(k) }))];
}
export const filterItems = (items: readonly TodayItem[], f: KindFilter) => (f === "all" ? [...items] : items.filter((i) => i.kind === f));

const dayNumber = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
const localYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The badge on a follow-up row: "3 days late" in red, or "Due today" in amber. Null for other kinds or an unreadable date. */
export function dueBadge(item: Pick<TodayItem, "kind" | "due">, now = new Date()): { tone: "critical" | "warning"; label: string } | null {
  if (item.kind !== "follow_up_due" || !item.due || !/^\d{4}-\d{2}-\d{2}/.test(item.due)) return null;
  const late = dayNumber(localYmd(now)) - dayNumber(item.due.slice(0, 10));
  return late > 0 ? { tone: "critical", label: `${late} ${late === 1 ? "day" : "days"} late` } : { tone: "warning", label: "Due today" };
}

/** The second line of a row. A follow-up adds when you last contacted them; a quick scan adds what the full scan costs. */
export function itemReason(item: Pick<TodayItem, "kind" | "reason">, ctx: { contactedAt?: string | null; score?: number | null; fullScanCostUsd?: number | null }): string {
  if (item.kind === "follow_up_due" && ctx.contactedAt) {
    const t = Date.parse(ctx.contactedAt);
    if (Number.isFinite(t)) return `${item.reason} · contacted ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }
  if (item.kind === "promising_quick_scan" && ctx.score != null && ctx.fullScanCostUsd != null) return `Quick scan scored ${ctx.score} · full scan ≈ $${ctx.fullScanCostUsd.toFixed(2)}`;
  return item.reason;
}

/** Where a row's main button goes: the lead, or the lead's email tab for an unsent draft. Null for "Run full scan", which is a request, not a link. */
export const itemLink = (item: Pick<TodayItem, "kind" | "businessId">): string | null =>
  item.kind === "promising_quick_scan" ? null : `/leads/${item.businessId}${item.kind === "draft_unsent" ? "?tab=email" : ""}`;

export const filterEmpty = (f: KindFilter) => (f === "all" ? "" : `Nothing under ${KIND_VIEW[f].pill} right now.`);
