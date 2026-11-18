import type { SequenceStep } from "./types";

export type StepState = "sent" | "pending" | "due" | "upcoming" | "skipped";
/** GET /api/leads/:id/sequence, one entry per step of the campaign's email and call steps. */
export interface StepView { step: SequenceStep; state: StepState; at: string | null }

/** "Dec 18", the UTC day of a timestamp. */
const monthDay = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * One step's state as a short phrase. An upcoming step whose day has already come reads "Due now", since the daily scan will propose
 * it next. A missing or unreadable date leaves the day off rather than showing "Invalid Date".
 */
export function stepStateLabel(state: StepState, at: string | null, now: Date): string {
  const t = at ? Date.parse(at) : NaN;
  switch (state) {
    case "sent": return Number.isNaN(t) ? "Sent" : `Sent ${monthDay(at!)}`;
    case "pending": return "Waiting for your OK";
    case "due": return "Due now";
    case "upcoming":
      if (Number.isNaN(t)) return "Upcoming";
      return t <= now.getTime() ? "Due now" : `Due ${monthDay(at!)}`;
    case "skipped": return "Skipped";
  }
}

export type EnrollmentStatus = "active" | "nurture" | "replied" | "stopped" | "bounced" | "completed";
export const isLiveStatus = (s: EnrollmentStatus): boolean => s === "active" || s === "nurture";
export const ENROLLMENT_LABEL: Record<EnrollmentStatus, string> = {
  active: "Active", nurture: "Checking back later", replied: "Replied", stopped: "Stopped", bounced: "Bounced", completed: "Finished",
};
export const ENROLLMENT_TONE: Record<EnrollmentStatus, "positive" | "info" | "warning" | "critical" | "neutral"> = {
  active: "positive", nurture: "info", replied: "info", stopped: "neutral", bounced: "critical", completed: "neutral",
};

/** GET /api/leads/:id/sequence. `enrollment` is the lead's newest one, live or finished. */
export interface EnrollmentView {
  id: string; campaign_id: string; campaign_name: string | null; status: EnrollmentStatus; to_email: string;
  started_at: string; last_sent_at: string | null; last_error: string | null; stopped_reason: string | null;
  next_step_index: number; next_due_at: string | null;
}
export interface SequenceMessage {
  id: string; direction: "out" | "in"; subject: string; counterpart: string; text: string; status: "sending" | "sent" | "failed" | "received";
  step_index: number | null; created_at: string; sent_at: string | null;
}
export interface SequenceData { enrollment: EnrollmentView | null; steps: StepView[]; messages: SequenceMessage[] }

/** "Email 1", "Call", "Email 2": emails are numbered in order, as the approvals title them. */
export function stepTitle(steps: StepView[], idx: number): string {
  const s = steps.find((x) => x.step.idx === idx)?.step;
  if (!s) return `Step ${idx + 1}`;
  if (s.kind === "call") return "Call";
  if (s.kind === "checkin") return "Check-in";
  return `Email ${steps.filter((x) => x.step.kind === "email" && x.step.idx <= idx).length}`;
}

/** The words beside a step. A call the sequence has moved past was handed to the owner, not sent. */
export function stepStatusText(v: StepView, now: Date): string {
  if (v.step.kind === "call" && v.state === "sent") return "On your follow-up list";
  return stepStateLabel(v.state, v.at, now);
}

/** "Sent" for an outbound message, "Received" for an inbound one; a send in progress or failed says so. */
export function messageLabel(m: Pick<SequenceMessage, "direction" | "status">): string {
  if (m.direction === "in") return "Received";
  return m.status === "sending" ? "Sending" : m.status === "failed" ? "Failed" : "Sent";
}

/** The campaigns the picker offers: archived ones are left out, the rest keep the server's order. */
export const pickableCampaigns = <T extends { status: string }>(list: T[]): T[] => list.filter((c) => c.status !== "archived");
