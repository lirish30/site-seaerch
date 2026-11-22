import type { EditLedger } from "../worker/care/ledger";
import type { ReportRow } from "../worker/care/reportAdmin";
import { hours } from "./careReportPageView";

/** The words on the owner's reports page and the Care panel's edit-hours bar: pure functions, so the pages only lay text out. Worker types are imported as types only. */

export type { ReportRow };
type Status = ReportRow["status"];

const CHIP: Record<Status, string> = { collecting: "Collecting numbers", ready: "Ready to send", sent: "Sent", revoked: "Taken back", cancelled: "Cancelled" };
const TONE: Record<Status, "" | "positive" | "warning" | "critical"> = { collecting: "", ready: "warning", sent: "positive", revoked: "critical", cancelled: "" };

/** A report's status in words (the chip always says it; the colour only helps). */
export const statusChip = (s: Status): string => CHIP[s] ?? "Unknown";
/** The chip's tone: a ready one waits on Logan (amber), a sent one is done (green), a taken-back one is red. */
export const statusTone = (s: Status): "" | "positive" | "warning" | "critical" => TONE[s] ?? "";

/** Where a client's report for the month stands, in the order the month moves: no report yet, collecting, ready for Logan's OK, sent, opened by the client. Revoked and cancelled are "off". */
export type MonthStage = "none" | "collecting" | "ready" | "sent" | "opened" | "off";
export const MONTH_STAGES: { stage: Exclude<MonthStage, "off">; label: string; hint: string }[] = [
  { stage: "none", label: "Not started", hint: "No report yet" },
  { stage: "collecting", label: "Collecting", hint: "Numbers and words" },
  { stage: "ready", label: "Ready for your OK", hint: "Approve on Today" },
  { stage: "sent", label: "Sent", hint: "Not opened yet" },
  { stage: "opened", label: "Opened", hint: "The client read it" },
];
/** The stage of one report; a client with no report (null) has not started. */
export function monthStage(r: Pick<ReportRow, "status" | "views"> | null): MonthStage {
  if (!r) return "none";
  if (r.status === "sent") return r.views > 0 ? "opened" : "sent";
  return r.status === "collecting" || r.status === "ready" ? r.status : "off";
}
/** The stage in words for a chip: the five stages above, and the report's own word for one taken back or cancelled. */
export function stageLabel(stage: MonthStage, status?: Status): string {
  if (stage === "off") return status ? statusChip(status) : "Taken back";
  return MONTH_STAGES.find((s) => s.stage === stage)?.label ?? "Unknown";
}

export interface LedgerBar {
  /** Green below 80%, amber from 80% up to the allowance, red over it; `none` when there is no allowance and no time used. */
  tone: "ok" | "warn" | "over" | "none";
  /** Fill, 0 to 100 (whole percent, capped). */
  width: number;
  label: string;
  /** A short line under the bar when it needs a word, else empty. */
  note: string;
}

/** The edit-hours bar for a month, or null for a client with no live Care plan. A null percent (an allowance of 0) says "no allowance" and never a percentage. The tone is the ledger's own state. */
export function ledgerBar(l: Pick<EditLedger, "usedMinutes" | "allowanceMinutes" | "percent" | "state"> | null): LedgerBar | null {
  if (!l) return null;
  if (l.percent === null) {
    return l.usedMinutes > 0 ? { tone: "over", width: 100, label: `${hours(l.usedMinutes)} used, no allowance`, note: "" } : { tone: "none", width: 0, label: "no allowance", note: "" };
  }
  const note = l.state === "over" ? "Over the allowance: quote the extra time" : l.state === "warn" ? `${l.percent}% used: nearly out of edit time` : "";
  return { tone: l.state, width: Math.max(0, Math.min(100, l.percent)), label: `${hours(l.usedMinutes)} of ${hours(l.allowanceMinutes)} used`, note };
}

/** "30 min of 1 h"; empty for a client with no ledger. */
export function editHoursLine(l: Pick<EditLedger, "usedMinutes" | "allowanceMinutes"> | null): string {
  return l ? `${hours(l.usedMinutes)} of ${hours(l.allowanceMinutes)}` : "";
}
