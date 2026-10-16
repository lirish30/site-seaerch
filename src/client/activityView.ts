import type { IconName } from "./components/iconMarkup";
import { STAGE_LABEL } from "./leadView";
import type { Activity, LeadStatus } from "./types";

export type ActivityFilter = "all" | "notes" | "stage" | "emails" | "audits" | "other";
export const ACTIVITY_FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "notes", label: "Notes" }, { key: "stage", label: "Stage" },
  { key: "emails", label: "Emails" }, { key: "audits", label: "Audits" }, { key: "other", label: "Other" },
];

/** Which filter pill an activity belongs to. */
export function filterOf(kind: string): Exclude<ActivityFilter, "all"> {
  if (kind === "note") return "notes";
  if (kind === "status") return "stage";
  if (kind === "draft" || kind === "export") return "emails";
  if (kind === "reaudit" || kind === "score_flagged" || kind === "cro_audit") return "audits";
  return "other";
}

export interface ActivityDisplay { icon: IconName; tone: "signal" | "critical" | "info" | "warning" | "positive" | "neutral"; title: string; detail: string | null; bubble: boolean }

const stageWord = (s: string) => STAGE_LABEL[s as LeadStatus] ?? s;
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How one activity row reads on the timeline: an icon and tone, a title and an optional second line. */
export function describeActivity(a: Pick<Activity, "kind" | "detail">): ActivityDisplay {
  const d = a.detail?.trim() || null;
  switch (a.kind) {
    case "note": return { icon: "pen", tone: "warning", title: "Note", detail: d, bubble: true };
    case "status": {
      const m = d && /^(\w+)\s*→\s*(\w+)$/.exec(d);
      return { icon: "kanban", tone: "info", title: m ? `Stage changed: ${stageWord(m[1])} → ${stageWord(m[2])}` : "Stage changed", detail: m ? null : d, bubble: false };
    }
    case "export":
      if (d?.startsWith("Gmail draft")) return { icon: "mail", tone: "info", title: "Gmail draft created", detail: `${d.includes("audit PDF") ? "Attached the audit PDF. " : ""}Nothing was sent.`, bubble: false };
      if (d?.includes("Drive")) return { icon: "upload", tone: "info", title: "Saved to Google Drive", detail: null, bubble: false };
      return { icon: "file-text", tone: "info", title: d ? upperFirst(d) : "Exported", detail: null, bubble: false };
    case "draft": return { icon: "sparkles", tone: "signal", title: d?.startsWith("Rewrote") ? "Draft rewritten" : "Draft written", detail: d, bubble: false };
    case "reaudit": return { icon: "refresh", tone: "neutral", title: d === "Full scan" ? "Full scan started" : "Re-audit started", detail: null, bubble: false };
    case "score_flagged": return { icon: "alert", tone: "critical", title: "Score flagged", detail: d, bubble: false };
    case "cro_audit": return { icon: "target", tone: "neutral", title: "Conversion plan built", detail: null, bubble: false };
    case "starred": return { icon: "star", tone: "warning", title: "Starred", detail: null, bubble: false };
    case "unstarred": return { icon: "star", tone: "neutral", title: "Unstarred", detail: null, bubble: false };
    case "archived": return { icon: "copy", tone: "neutral", title: "Archived", detail: null, bubble: false };
    case "restored": return { icon: "copy", tone: "neutral", title: "Restored", detail: null, bubble: false };
    case "website": return { icon: "globe", tone: "neutral", title: "Website changed", detail: d, bubble: false };
    case "suppressed": return { icon: "ban", tone: "critical", title: "Marked do-not-contact", detail: d, bubble: false };
    case "import": return { icon: "upload", tone: "neutral", title: d?.startsWith("Also") ? "Also imported" : "Imported", detail: d, bubble: false };
    case "bulk": return { icon: "list", tone: "neutral", title: "Bulk change", detail: d, bubble: false };
    case "today_done": return { icon: "check", tone: "positive", title: "Marked done in Home", detail: null, bubble: false };
    case "snoozed": return { icon: "clock", tone: "neutral", title: "Snoozed", detail: d, bubble: false };
    default: return { icon: "info", tone: "neutral", title: upperFirst(a.kind.replace(/_/g, " ")), detail: d, bubble: false };
  }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" AM", " am").replace(" PM", " pm");

/** "Today, 9:02 am", "Oct 2, 3:18 pm" this month, "Sep 28" before that. */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return `Today, ${time(d)}`;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? `${date}, ${time(d)}` : date;
}

/** Newest first, in groups: "This week", "Earlier in October", "September" (with the year once it is not this one). */
export function groupActivity<T extends Pick<Activity, "created_at">>(items: T[], now = new Date()): { label: string; items: T[] }[] {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const groups: { label: string; items: T[] }[] = [];
  for (const a of [...items].sort((x, y) => y.created_at.localeCompare(x.created_at))) {
    const d = new Date(a.created_at);
    const month = d.toLocaleDateString("en-US", { month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
    const sameMonth = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    const label = d.getTime() >= weekAgo ? "This week" : sameMonth ? `Earlier in ${d.toLocaleDateString("en-US", { month: "long" })}` : month;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(a); else groups.push({ label, items: [a] });
  }
  return groups;
}
