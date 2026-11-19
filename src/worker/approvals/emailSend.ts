import { z } from "zod";
import { registerHandler } from "./registry";
import type { Drafter } from "../db/approvals";
import type { Settings } from "../types";
import { BRAND_HOST, composeOutbound, sendEmail } from "../mail/send";
import { getMailbox } from "../db/mailboxes";
import type { MailboxKey } from "../mail/types";

const OneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, "must be one line");

/**
 * The video audit's GIF and the page it links to, for Email 1 of a video campaign. Both are https URLs on ONE host that is neither workers.dev nor
 * the brand domain: the href is a report page (`/r/<token>`), the src a file the report's media route serves (`/api/public/report/<token>/...`).
 * That the host is the configured OUTREACH_LINK_BASE is not known here; the engine builds it from that base and the send checks it again (`linkProblem`).
 * `alt` is one line; the page that builds the hero caps a scraped business name to fit.
 */
export const HeroImageSchema = z.object({
  src: z.string().trim().max(2000), href: z.string().trim().max(2000), alt: OneLine(120),
}).strict().superRefine((h, ctx) => {
  const parse = (v: string) => { try { return new URL(v); } catch { return null; } };
  const src = parse(h.src), href = parse(h.href);
  const bad = (path: "src" | "href", message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const check = (u: URL | null, path: "src" | "href", prefix: string) => {
    if (!u || u.protocol !== "https:") return bad(path, "must be an https URL");
    if (u.username || u.password || u.search || u.hash) return bad(path, "must be a plain link");
    if (!u.pathname.startsWith(prefix) || u.pathname.length === prefix.length) bad(path, `must be under ${prefix}`);
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    if (/(^|\.)workers\.dev$/.test(host)) bad(path, "must not be a workers.dev link");
    if (host === BRAND_HOST || host.endsWith(`.${BRAND_HOST}`)) bad(path, "must not be on the main brand domain");
  };
  check(src, "src", "/api/public/report/");
  check(href, "href", "/r/");
  if (src && href && src.host.toLowerCase() !== href.host.toLowerCase()) bad("src", "must be on the same host as href");
});
export type HeroImage = z.infer<typeof HeroImageSchema>;

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
  heroImage: HeroImageSchema.optional(),
});
export type EmailSendPayload = z.infer<typeof EmailSendSchema>;

const PREVIEW_CHARS = 400;

/** The address a mailbox sends from, for the preview's From line; undefined when the mailbox row is missing or has no address yet. */
export async function mailboxFromEmail(db: D1Database, key: MailboxKey): Promise<string | undefined> {
  try { return (await getMailbox(db, key)).from_email.trim() || undefined; } catch { return undefined; }
}

/**
 * The `createApproval` arguments for one email, with a preview that shows the sender, recipient, subject and the start of the composed text.
 * `fromEmail` is the mailbox's address (see `mailboxFromEmail`); without it the From line names the mailbox.
 */
export function buildEmailSendApproval(p: EmailSendPayload & { title: string; drafted_by: Drafter }, settings: Settings, fromEmail?: string) {
  const { title, drafted_by, ...rest } = p;
  const payload = EmailSendSchema.parse(rest);
  const composed = composeOutbound(settings, payload);
  return {
    kind: "email.send" as const,
    title,
    preview: `From: ${fromEmail ?? `${payload.mailbox} mailbox (no address set yet)`}\nTo: ${payload.to}\nSubject: ${payload.subject}\n${payload.heroImage ? `Video: ${payload.heroImage.href}\n` : ""}\n${composed.text.slice(0, PREVIEW_CHARS)}`,
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
    // `sendEmail` runs the checks in order, AFTER its already-sent short-circuit so a retry of a sent message cannot fail on them:
    // mailbox enabled, conflict gate, the enrollment is still active or nurture, footer and address, link guard, warm-up and daily cap, once-only send.
    // After a send, `sendEmail` advances the enrollment (`advanceAfterSend`), also on a retry of an already-sent approval.
    await sendEmail(env, p, { approvalId: a.id });
  },
});
