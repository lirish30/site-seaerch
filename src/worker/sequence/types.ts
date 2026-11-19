import type { MailboxKey } from "../mail/types";

export type EnrollmentStatus = "active" | "nurture" | "replied" | "stopped" | "bounced" | "completed";
/** Statuses in which a sequence may still send (and the ones the one-live-enrollment-per-lead index covers). */
export const LIVE_STATUSES: readonly EnrollmentStatus[] = ["active", "nurture"];
export const isLive = (s: EnrollmentStatus): boolean => LIVE_STATUSES.includes(s);

export type StopReason = "replied" | "opt_out" | "bounced" | "manual" | "booked";

export interface Enrollment {
  id: string; business_id: string; campaign_id: string; mailbox_key: MailboxKey; to_email: string;
  status: EnrollmentStatus;
  /** The step the sequence is waiting on. */
  next_step_index: number;
  /** When that step may be proposed; NULL until step 0 has been sent. */
  next_due_at: string | null;
  started_at: string; last_sent_at: string | null; last_error: string | null; stopped_reason: string | null;
  /** Highest step recorded as sent; NULL before step 0. */
  last_sent_step: number | null;
}
