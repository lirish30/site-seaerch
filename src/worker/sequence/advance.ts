import type { SequenceStep } from "../db/campaigns";
import { listSteps } from "../db/campaigns";
import { getEnrollment } from "../db/enrollments";
import { addBusinessDays, addCalendarDays } from "./dates";
import type { Enrollment } from "./types";

/** The least time between two touches: the next step is never due sooner than this many business days after the last one. */
export const MIN_GAP_BUSINESS_DAYS = 3;

/** Steps the sequence itself runs. A `checkin` belongs to the nurture flow (a lead that said "not now"), never to this one. */
const isSequenceStep = (s: SequenceStep) => s.kind === "email" || s.kind === "call";

/** The first email or call step at or after `idx`. */
export const stepFrom = (steps: SequenceStep[], idx: number): SequenceStep | null => steps.find((s) => s.idx >= idx && isSequenceStep(s)) ?? null;
/** The first email or call step after `idx`. */
export const stepAfter = (steps: SequenceStep[], idx: number): SequenceStep | null => stepFrom(steps, idx + 1);

/** When a step falls by its own offset, counted from the day the sequence started. */
export const offsetDue = (startedAt: Date, s: Pick<SequenceStep, "offset_days" | "offset_kind">): Date =>
  s.offset_kind === "business" ? addBusinessDays(startedAt, s.offset_days) : addCalendarDays(startedAt, s.offset_days);

/** The later of the step's own offset and `base` plus the minimum gap, so a late approval never bunches the next touch up behind it. */
export function dueAfter(startedAt: Date, next: Pick<SequenceStep, "offset_days" | "offset_kind">, base: Date): Date {
  const byOffset = offsetDue(startedAt, next), byGap = addBusinessDays(base, MIN_GAP_BUSINESS_DAYS);
  return byOffset.getTime() >= byGap.getTime() ? byOffset : byGap;
}

/** Where the enrollment goes after step `fromIdx` is done: the next step and its due time, or null when the sequence is over. */
export function planNext(e: Pick<Enrollment, "started_at">, steps: SequenceStep[], fromIdx: number, base: Date): { index: number; dueAt: string } | null {
  const next = stepAfter(steps, fromIdx);
  return next ? { index: next.idx, dueAt: dueAfter(new Date(e.started_at), next, base).toISOString() } : null;
}

/**
 * Records that step `stepIndex` was sent at `sentAt` and moves the enrollment to its next step (due no earlier than
 * `sentAt` + 3 business days), or to `completed` after the last email. Called by `sendEmail` once the message row is `sent`.
 *
 * IDEMPOTENT: it runs again on every retry of an approval whose message is already sent. `last_sent_step` is the guard, and the
 * single UPDATE both tests and sets it, so concurrent repeats change the row once. A sequence that was stopped in the meantime
 * still records the send but is never moved or revived.
 */
export async function advanceAfterSend(db: D1Database, enrollmentId: string, stepIndex: number, sentAt: Date): Promise<void> {
  const e = await getEnrollment(db, enrollmentId);
  if (!e || (e.last_sent_step !== null && e.last_sent_step >= stepIndex)) return;
  const plan = planNext(e, await listSteps(db, e.campaign_id), stepIndex, sentAt);
  await db.prepare(
    `UPDATE enrollments SET last_sent_step = ?1, last_sent_at = ?2, last_error = NULL,
       next_step_index = CASE WHEN status IN ('active','nurture') THEN ?3 ELSE next_step_index END,
       next_due_at = CASE WHEN status IN ('active','nurture') THEN ?4 ELSE next_due_at END,
       status = CASE WHEN status IN ('active','nurture') THEN COALESCE(?5, status) ELSE status END
     WHERE id = ?6 AND (last_sent_step IS NULL OR last_sent_step < ?1)`,
  ).bind(stepIndex, sentAt.toISOString(), plan?.index ?? stepIndex + 1, plan?.dueAt ?? null, plan ? null : "completed", enrollmentId).run();
}

/**
 * Moves an active enrollment past step `fromIdx` without a send (a call that was handed to Logan, or an email he rejected).
 * The gap is counted from `now`. True when this caller moved it; false when another run already had.
 */
export async function moveOn(db: D1Database, e: Enrollment, steps: SequenceStep[], fromIdx: number, now: Date): Promise<boolean> {
  const plan = planNext(e, steps, fromIdx, now);
  const r = await db.prepare(
    `UPDATE enrollments SET next_step_index = ?, next_due_at = ?, last_error = NULL, status = COALESCE(?, status)
     WHERE id = ? AND status = 'active' AND next_step_index = ?`,
  ).bind(plan?.index ?? fromIdx + 1, plan?.dueAt ?? null, plan ? null : "completed", e.id, e.next_step_index).run();
  return (r.meta.changes ?? 0) > 0;
}
