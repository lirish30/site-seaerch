import { getDocument } from "../db/documents";
import { getInvoiceByRef, insertDraftInvoice } from "../db/invoices";
import { listMilestones, listProjects, type Project } from "../db/projects";
import type { Env } from "../env";
import { onMilestone } from "../projects/hooks";
import type { MilestoneKey } from "../sop/model";
import { draftAndPropose } from "./draft";

type DraftInput = Parameters<typeof insertDraftInvoice>[1];

export const milestoneRef = (documentId: string, m: MilestoneKey): string => `milestone:${documentId}:${m}`;

/**
 * The draft a project's milestone calls for, or null when none is due: a test or cancelled project, no document, a document that is not signed and paid, or a payment schedule with
 * nothing due at this milestone. The amount is the one the signed document froze (never today's catalog price), as one line `<label> (<reference>)`.
 */
async function milestoneInput(env: Env, p: Project, m: MilestoneKey): Promise<DraftInput | null> {
  if (p.test || p.status === "cancelled" || !p.documentId) return null;
  const doc = await getDocument(env.DB, p.documentId);
  if (!doc || doc.test || doc.status !== "signed" || !doc.paidAt) return null;
  const ms = doc.content.schedule.milestones.find((x) => x.dueOn === m);
  if (!ms) return null;
  const what = `${ms.label} (${doc.content.header.reference})`;
  return {
    businessId: p.businessId, dealId: p.dealId ?? doc.dealId, documentId: doc.id, projectId: p.id, changeOrderId: null, subscriptionId: null,
    kind: "milestone", ref: milestoneRef(doc.id, m), test: false, description: what, lines: [{ description: what, amountCents: ms.amountCents }],
  };
}

/** The draft invoice for a project's milestone (made once: a second call returns the first), or null when none is due. Nothing is proposed or sent. */
export async function milestoneInvoice(env: Env, p: Project, m: MilestoneKey) {
  const input = await milestoneInput(env, p, m);
  return input ? (await insertDraftInvoice(env.DB, input)).invoice : null;
}

/** The hook: a project reached a milestone, so its invoice is drafted and put up for Logan's approval. Safe to run twice. */
export async function milestoneHook(env: Env, p: Project, m: MilestoneKey): Promise<void> {
  const input = await milestoneInput(env, p, m);
  if (input) await draftAndPropose(env, input);
}

/**
 * The safety net for a hook that never ran or failed: every real, not-cancelled project with a reached milestone and no invoice of that ref gets one (drafted and proposed).
 * A draft that exists, even one whose approval was rejected, is left alone. Returns how many were made.
 */
export async function reconcileMilestones(env: Env): Promise<number> {
  let made = 0;
  for (const p of await listProjects(env.DB, { status: ["active", "paused", "done"] })) {
    if (p.test || !p.documentId) continue;
    for (const { milestone } of await listMilestones(env.DB, p.id)) {
      const input = await milestoneInput(env, p, milestone);
      if (!input || (await getInvoiceByRef(env.DB, input.ref))) continue;
      await draftAndPropose(env, input);
      made++;
    }
  }
  return made;
}

onMilestone(milestoneHook);
