import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { getBusiness } from "../db/businesses";
import { getCampaign, listSteps, type SequenceStep } from "../db/campaigns";
import { logActivity } from "../db/activity";
import { enrollmentsFor } from "../db/enrollments";
import { listForBusiness } from "../db/messages";
import { startSequence } from "../sequence/engine";
import { offsetDue } from "../sequence/advance";
import { stopOutreach } from "../sequence/stop";
import { isLive, type Enrollment } from "../sequence/types";

export type StepState = "sent" | "pending" | "due" | "upcoming" | "skipped";
export interface StepView { step: SequenceStep; state: StepState; at: string | null }

const StartBody = z.object({ campaignId: z.string().trim().min(1) }).strict();
const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

/**
 * What each step of the enrollment's campaign looks like right now. Only email and call steps are listed: a `checkin` belongs to the
 * nurture flow and this sequence never runs it. Per step, first match wins:
 *  - sent:     an outbound message for this step is `sent` (at = when), or it is a call the sequence has moved past (handed to the owner, at = null);
 *  - pending:  an `email.send` approval for this step is pending, or approved and mid-send (at = when it was proposed);
 *  - skipped:  the owner rejected this step's approval, or the sequence is over (stopped, replied, bounced, completed) and it never went;
 *  - due:      the sequence is waiting on this step (`next_step_index`) and `next_due_at` has passed, so the daily scan proposes it next;
 *  - upcoming: everything else. `at` is when it can first go: `next_due_at` for the next step; for a later one the later of its own
 *              offset from the start and `next_due_at` (the real time moves with each send, so this is the earliest it can be).
 */
export function stepStates(
  e: Enrollment, steps: SequenceStep[], sent: Map<number, string | null>, open: Map<number, string>, rejected: Set<number>, now: Date,
): StepView[] {
  const live = isLive(e.status);
  return steps.filter((s) => s.kind === "email" || s.kind === "call").map((step): StepView => {
    const idx = step.idx;
    if (sent.has(idx)) return { step, state: "sent", at: sent.get(idx)! };
    if (step.kind === "call" && e.last_sent_step !== null && idx < e.next_step_index) return { step, state: "sent", at: null };
    if (open.has(idx)) return { step, state: "pending", at: open.get(idx)! };
    if (rejected.has(idx) || !live) return { step, state: "skipped", at: null };
    const dueAt = e.next_due_at;
    if (idx === e.next_step_index) {
      if (dueAt && Date.parse(dueAt) <= now.getTime()) return { step, state: "due", at: dueAt };
      return { step, state: "upcoming", at: dueAt };
    }
    if (idx > e.next_step_index) {
      const own = offsetDue(new Date(e.started_at), step).getTime();
      return { step, state: "upcoming", at: dueAt ? new Date(Math.max(own, Date.parse(dueAt))).toISOString() : null };
    }
    return { step, state: "skipped", at: null }; // a step before the one being waited on that never went and was not rejected
  });
}

async function stepSignals(db: D1Database, enrollmentId: string) {
  const [msgs, approvals] = await Promise.all([
    db.prepare(`SELECT step_index, sent_at FROM messages WHERE enrollment_id = ? AND direction = 'out' AND status = 'sent' AND step_index IS NOT NULL`)
      .bind(enrollmentId).all<{ step_index: number; sent_at: string | null }>(),
    db.prepare(`SELECT status, created_at, json_extract(payload, '$.stepIndex') AS step_index FROM approvals
                WHERE kind = 'email.send' AND record_type = 'enrollment' AND record_id = ?`).bind(enrollmentId).all<{ status: string; created_at: string; step_index: number | null }>(),
  ]);
  const sent = new Map<number, string | null>(), open = new Map<number, string>(), rejected = new Set<number>();
  for (const m of msgs.results) sent.set(m.step_index, m.sent_at);
  for (const a of approvals.results) {
    if (a.step_index === null) continue;
    if (a.status === "rejected") rejected.add(a.step_index);
    else if (a.status === "pending" || a.status === "approved") open.set(a.step_index, a.created_at);
  }
  return { sent, open, rejected };
}

export const sequenceRoutes = new Hono<{ Bindings: Env }>();

sequenceRoutes.post("/:id/sequence/start", async (c) => {
  const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const businessId = c.req.param("id");
  // Order of refusals: bad body 400, unknown campaign 404, archived campaign 409, then the engine's own (unknown lead 404, ...).
  const campaign = await getCampaign(c.env.DB, parsed.data.campaignId);
  if (!campaign) return c.json({ error: "campaign not found" }, 404);
  if (campaign.status === "archived") return c.json({ error: "campaign is archived" }, 409);
  const r = await startSequence(c.env, { businessId, campaignId: campaign.id });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  await logActivity(c.env.DB, businessId, "note", `Sequence started: ${campaign.name}; Email 1 is waiting for your OK`);
  return c.json({ enrollmentId: r.enrollmentId, approvalId: r.approvalId }, 201);
});

// The lead's newest enrollment (live or finished), its steps with their state, and its messages.
sequenceRoutes.get("/:id/sequence", async (c) => {
  const db = c.env.DB, businessId = c.req.param("id");
  if (!(await getBusiness(db, businessId))) return c.json({ error: "lead not found" }, 404);
  const [enrollments, messages] = await Promise.all([enrollmentsFor(db, businessId), listForBusiness(db, businessId, 50)]);
  const e = enrollments.find((x) => isLive(x.status)) ?? enrollments[0] ?? null;
  if (!e) return c.json({ enrollment: null, steps: [], messages });
  const [steps, signals, campaign] = await Promise.all([listSteps(db, e.campaign_id), stepSignals(db, e.id), getCampaign(db, e.campaign_id)]);
  return c.json({
    enrollment: { ...e, campaign_name: campaign?.name ?? null },
    steps: stepStates(e, steps, signals.sent, signals.open, signals.rejected, getMailDeps().now()),
    messages,
  });
});

sequenceRoutes.post("/:id/sequence/stop", async (c) => {
  const db = c.env.DB, businessId = c.req.param("id");
  if (!(await getBusiness(db, businessId))) return c.json({ error: "lead not found" }, 404);
  if (!(await enrollmentsFor(db, businessId)).some((e) => isLive(e.status))) return c.json({ error: "this lead is not in a sequence" }, 404);
  const { rejectedApprovals } = await stopOutreach(db, { businessId, reason: "manual" });
  return c.json({ ok: true, rejectedApprovals });
});
