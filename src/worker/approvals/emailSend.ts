import { z } from "zod";
import { registerHandler } from "./registry";
import type { Drafter } from "../db/approvals";
import type { Settings } from "../types";
import { checkConflict } from "../mail/conflictStub";
import { composeOutbound, loadSendable, sendEmail } from "../mail/send";

const OneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, "must be one line");

/** The `email.send` payload. `body` is the draft before signature and footer; the handler composes the final message at send time. */
export const EmailSendSchema = z.object({
  mailbox: z.enum(["outreach", "main"]),
  businessId: z.string().min(1),
  to: z.email().max(254),
  subject: OneLine(200),
  body: z.string().trim().min(1),
  includeFooter: z.boolean(),
  enrollmentId: z.string().min(1).optional(),
  stepIndex: z.number().int().min(0).optional(),
  inReplyTo: OneLine(500).optional(),
});
export type EmailSendPayload = z.infer<typeof EmailSendSchema>;

const PREVIEW_CHARS = 400;

/** The `createApproval` arguments for one email, with a preview that shows the recipient, subject and the start of the composed text. */
export function buildEmailSendApproval(p: EmailSendPayload & { title: string; drafted_by: Drafter }, settings: Settings) {
  const { title, drafted_by, ...rest } = p;
  const payload = EmailSendSchema.parse(rest);
  const composed = composeOutbound(settings, payload);
  return {
    kind: "email.send" as const,
    title,
    preview: `To: ${payload.to}\nSubject: ${payload.subject}\n\n${composed.text.slice(0, PREVIEW_CHARS)}`,
    payload,
    record_type: payload.enrollmentId ? "enrollment" : "lead",
    record_id: payload.enrollmentId ?? payload.businessId,
    drafted_by,
  };
}

registerHandler({
  kind: "email.send",
  label: "Send email",
  parse: (p) => EmailSendSchema.parse(p),
  async execute(env, p: EmailSendPayload, a) {
    await loadSendable(env, p.mailbox, true); // 1. mailbox enabled, password secret present
    const c = await checkConflict(env.DB, { email: p.to, businessId: p.businessId }); // 2. conflict gate (Task 5)
    if (c.blocked) throw new Error(`blocked: ${c.reason} (${c.source})`);
    // Task 7 adds the enrollment-status check here.
    await sendEmail(env, p, { approvalId: a.id }); // 3-6. footer and address, link guard, warm-up and daily cap, once-only send
  },
});
