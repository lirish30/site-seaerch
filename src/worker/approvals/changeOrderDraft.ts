import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import type { Approval } from "../db/approvals";
import { logActivityOnce } from "../db/activity";
import { draftChangeOrder } from "../changeorders/service";
import { getProject } from "../db/projects";
import { cleanText } from "../onboarding/templates";

/**
 * What an agent may ask for: a small piece of extra work it found in an email or a meeting. Strict, so a field this does not name (a price, a rate, a token) is refused rather than ignored.
 * The hours go in steps of 0.25 and top out at 40: anything bigger is a conversation, not a change order. Everything else (rate, price, deliverables) is Logan's to set on the draft.
 */
const Payload = z.object({
  projectId: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  summary: z.string().max(1500),
  reason: z.string().max(600),
  hours: z.number().min(0.25).max(40).refine((h) => Number.isInteger(h * 4), "Hours go in steps of 0.25."),
  source: z.enum(["email", "meeting"]),
  sourceNote: z.string().max(300).optional(),
}).strict();
export type ChangeOrderDraftPayload = z.infer<typeof Payload>;

registerHandler({
  kind: "change_order.draft",
  label: "Draft a change order",
  parse: (p) => Payload.parse(p),
  /**
   * Makes a DRAFT change order on the project and nothing more: it is never sent, never priced beyond the hourly rate, and Logan opens it, edits it and puts it up for send approval
   * himself. One draft per approval (the unique `origin_approval_id`), so running it again, or retrying after a failure, finds the same draft. An unknown, done or cancelled project is refused.
   */
  async execute(env: Env, p: ChangeOrderDraftPayload, a: Approval) {
    const project = await getProject(env.DB, p.projectId);
    if (!project) throw new Error("this project was not found, so no change order was drafted");
    const co = await draftChangeOrder(env, {
      projectId: p.projectId, title: p.title, summary: p.summary, reason: p.reason, hours: p.hours, sourceType: p.source, originApprovalId: a.id,
    });
    const note = p.sourceNote ? cleanText(p.sourceNote, 300) : "";
    await logActivityOnce(env.DB, co.businessId, "note", `Change order ${co.content.reference} drafted from ${p.source === "email" ? "an email" : "a meeting"}${note ? `: ${note}` : ""}`.slice(0, 400));
  },
});
