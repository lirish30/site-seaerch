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
  if (kind === "draft" || kind === "export" || kind === "email_sent" || kind === "email_reply" || kind === "email_bounce") return "emails";
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
    case "email_sent": return { icon: "send", tone: "info", title: "Email sent", detail: d, bubble: false };
    case "email_reply": return { icon: "mail", tone: "positive", title: "Reply received", detail: d, bubble: false };
    case "email_bounce": return { icon: "alert", tone: "critical", title: "Email bounced", detail: d, bubble: false };
    case "video_watch": return { icon: "eye", tone: "positive", title: d ?? "Watched the video audit", detail: null, bubble: false };
    case "booked": return { icon: "calendar", tone: "positive", title: "Call booked", detail: d, bubble: false };
    case "booking_cancelled": return { icon: "calendar", tone: "warning", title: "Call cancelled", detail: d, bubble: false };
    case "call_prep": return { icon: "sparkles", tone: d?.includes("did not") ? "warning" : "signal", title: d ?? "Call prep", detail: null, bubble: false };
    case "call_recap": return { icon: "sparkles", tone: d?.includes("did not") ? "warning" : "signal", title: d ?? "Call recap", detail: null, bubble: false };
    case "followup_booked": return { icon: "calendar", tone: "positive", title: "Recommendation meeting booked", detail: d, bubble: false };
    case "proposal_sent": return { icon: "send", tone: "info", title: "Proposal sent", detail: d, bubble: false };
    case "proposal_viewed": return { icon: "eye", tone: "positive", title: "Proposal viewed", detail: d, bubble: false };
    case "proposal_signed": return { icon: "check", tone: "positive", title: "Proposal signed", detail: d, bubble: false };
    // The daily sweep writes "<reference> v<n>: expired"; an owner's void writes the reason after the colon.
    case "proposal_void": return { icon: "ban", tone: "warning", title: d?.endsWith(": expired") ? "Proposal expired" : "Proposal voided", detail: d, bubble: false };
    case "deposit_paid": return { icon: "tag", tone: "positive", title: "Deposit paid", detail: d, bubble: false };
    case "onboarding_started": return { icon: "list", tone: "info", title: "Onboarding started", detail: d, bubble: false };
    case "onboarding_welcome": return { icon: "send", tone: "info", title: "Welcome sent", detail: d, bubble: false };
    case "onboarding_submitted": return { icon: "check", tone: "positive", title: "Questionnaire submitted", detail: d, bubble: false };
    case "onboarding_received": return { icon: "inbox", tone: "positive", title: "Client sent materials", detail: d, bubble: false };
    case "onboarding_waiting": return { icon: "clock", tone: "warning", title: "Waiting on the client", detail: d, bubble: false };
    case "onboarding_resumed": return { icon: "refresh", tone: "positive", title: "Client is back", detail: d, bubble: false };
    case "project_started": return { icon: "kanban", tone: "info", title: "Project started", detail: d, bubble: false };
    case "project_milestone": return { icon: "target", tone: "positive", title: "Project milestone", detail: d, bubble: false };
    case "project_done": return { icon: "check", tone: "positive", title: "Project finished", detail: d, bubble: false };
    case "change_order_sent": return { icon: "send", tone: "info", title: "Change order sent", detail: d, bubble: false };
    case "change_order_signed": return { icon: "check", tone: "positive", title: "Change order signed", detail: d, bubble: false };
    case "change_order_paid": return { icon: "card", tone: "positive", title: "Change order paid", detail: d, bubble: false };
    // The daily sweep writes "<reference> (<id>): expired"; an owner's void writes "... voided: <reason>".
    case "change_order_void": return { icon: "ban", tone: "warning", title: d && /\): expired$/.test(d) ? "Change order expired" : "Change order voided", detail: d, bubble: false };
    case "change_order_declined": return { icon: "ban", tone: "warning", title: "Change order declined", detail: d, bubble: false };
    case "invoice_sent": return { icon: "send", tone: "info", title: "Invoice sent", detail: d, bubble: false };
    case "invoice_paid": return { icon: "card", tone: "positive", title: "Invoice paid", detail: d, bubble: false };
    case "billing_hold_placed": return { icon: "ban", tone: "warning", title: "Work paused: invoice overdue", detail: d, bubble: false };
    // The server logs only the words (which field, which status), never an address, a vault item name or a note.
    case "site_added": return { icon: "globe", tone: "info", title: "Site added", detail: d?.replace(/^Site added:\s*/, "") || null, bubble: false };
    case "site_changed":
      if (d === "Site archived") return { icon: "globe", tone: "neutral", title: "Site archived", detail: null, bubble: false };
      return { icon: "globe", tone: "neutral", title: "Site changed", detail: d?.replace(/^Site updated:\s*/, "") || null, bubble: false };
    case "meeting_recorded": return { icon: "calendar", tone: "info", title: "Meeting recorded", detail: d?.replace(/^Meeting recorded:\s*/, "") || null, bubble: false };
    case "site_down": return { icon: "ban", tone: "critical", title: "Site down", detail: d, bubble: false };
    case "site_back": return { icon: "check", tone: "positive", title: "Site back up", detail: d, bubble: false };
    case "domain_expiring": return { icon: "clock", tone: "warning", title: "Domain expiring", detail: d, bubble: false };
    case "care_updated": return { icon: "check", tone: "positive", title: "Site updated", detail: d, bubble: false };
    case "care_rolled_back": return { icon: "ban", tone: "warning", title: "Update rolled back", detail: d, bubble: false };
    case "care_report_sent": return { icon: "mail", tone: "positive", title: "Care report sent", detail: d, bubble: false };
    case "seo_report_sent": return { icon: "mail", tone: "positive", title: "Local SEO report sent", detail: d, bubble: false };
    case "grade_set": return { icon: "star", tone: "info", title: "Client grade set", detail: d, bubble: false };
    case "ladder_sent": return { icon: "mail", tone: "positive", title: "Ladder step sent", detail: d, bubble: false };
    case "auto_approved": return { icon: "check", tone: "info", title: "Auto-approved", detail: d, bubble: false };
    case "studio_posted": return { icon: "check", tone: "positive", title: "Studio post published", detail: d, bubble: false };
    case "seo_baseline": return { icon: "target", tone: "info", title: "Local SEO baseline taken", detail: d, bubble: false };
    case "access_changed": return { icon: "key", tone: "info", title: "Access changed", detail: d, bubble: false };
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
