import type { MeetilySyncStatus, MeetingListItem } from "../worker/routes/meetings";
import type { MeetingSummary } from "../worker/meetings/summary";
import { shortDate } from "./billingView";
import { formatSlot } from "./bookingView";
import { CALLS_ZONE } from "./callsView";
import { hoursText } from "./changeOrderView";

/** Pure helpers for the meetings panel on a client's page and the Meetily line on the Mac helper page. No DOM, no fetch, no clock of its own. */

const STATUS_WORDS: Record<MeetingListItem["status"], string> = { received: "Waiting for its summary", summarized: "Summarized", failed: "Summary failed" };

/** One meeting in the list: its title, when it started (Pacific, zone named), where it stands, and the one line under it. */
export function meetingRow(m: MeetingListItem, tz = CALLS_ZONE): { title: string; when: string; status: string; headline: string } {
  const headline = m.status === "received" ? (m.summarizing ? "No summary yet. It is queued for Claude." : "No summary yet. Nothing is working on it. Use Summarize again.")
    : m.status === "failed" ? (m.summarizing ? "The summary did not run. A new one is queued for Claude." : "The summary did not run. Use Summarize again.")
    : m.summary || "Summarized.";
  return { title: m.title.trim() || "Untitled meeting", when: formatSlot(m.startedAt, tz), status: STATUS_WORDS[m.status], headline };
}

/** "Summarize again" is offered for a failed meeting or one still waiting, and only when no summary task is already open for it (asking then is refused). */
export const canSummarizeAgain = (m: { status: MeetingListItem["status"]; summarizing: boolean }): boolean => (m.status === "failed" || m.status === "received") && !m.summarizing;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 action items, 1 possible change order"; empty for a meeting with no summary yet. */
export function countsLine(m: Pick<MeetingListItem, "status" | "actionItems" | "changeOrders">): string {
  if (m.status !== "summarized") return "";
  if (m.actionItems === 0 && m.changeOrders === 0) return "No action items or change orders";
  return [plural(m.actionItems, "action item"), plural(m.changeOrders, "possible change order")].join(", ");
}

/** Each next step as "Logan: Draft the sitemap" or "Client: Send the logo files (due 5 Dec 2026)". */
export function actionItemLines(s: Pick<MeetingSummary, "actionItems">): string[] {
  return s.actionItems.map((a) => {
    const due = a.dueOn ? shortDate(a.dueOn, true) : "";
    return `${a.owner === "logan" ? "Logan" : "Client"}: ${a.title}${due ? ` (due ${due})` : ""}`;
  });
}

/** Each possible change order with Claude's hours, and where its draft is: in Home, waiting to be approved. Nothing here is priced or sent. */
export function changeOrderLines(s: Pick<MeetingSummary, "possibleChangeOrders">): string[] {
  return s.possibleChangeOrders.map((c) => `${c.title}: about ${hoursText(c.hours)}. A draft is waiting in Home as an approval.`);
}

export type FollowupState = "Not drafted" | "Waiting for your approval" | "Sent";

/** Where the follow-up email stands: sent once `followupSentAt` is set, waiting while its approval is pending in Home, otherwise not drafted (no summary yet, or the approval was decided without sending). */
export function followupState(m: { summary: MeetingSummary | null; followupSentAt: string | null; followupPending: boolean }): FollowupState {
  if (m.followupSentAt) return "Sent";
  return m.summary && m.followupPending ? "Waiting for your approval" : "Not drafted";
}

/** The Mac helper page's Meetily line, from GET /api/meetings/sync-status. */
export function meetilyLine(s: MeetilySyncStatus, tz = CALLS_ZONE): string {
  const at = s.lastSyncAt ? formatSlot(s.lastSyncAt, tz) : "";
  const base = s.lastStatus === "failed" && at ? `Meetily: the last sync failed (${at}).`
    : s.lastStatus === "failed" ? "Meetily: the last sync failed."
    : at ? `Meetily: last sync ${at}.` : "Meetily: no sync yet.";
  return s.pending ? `${base} A sync is waiting for your Mac.` : base;
}
