import { z } from "zod";
import { cleanText } from "../onboarding/templates";
import { activityIfChangedStmt } from "./activity";

export const CHANGE_ORDER_STATUSES = ["draft", "sent", "viewed", "signed", "declined", "void", "expired"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];
export type ChangeOrderSource = "logan" | "claude" | "email" | "meeting";

/** What the client reads and signs. Frozen (and hashed) when it is sent. Money is integer cents; hours are multiples of 0.25. */
export interface ChangeOrderContent {
  reference: string; title: string; summary: string; reason: string; deliverables: string[]; notIncluded: string[]; hours: number; rateCents: number; priceCents: number;
  scheduleImpactDays: number | null; clientName: string; contactName: string; contactEmail: string;
}

/** The text is cleaned (control and bidirectional characters removed, ends trimmed) before its length is checked, so what is stored is what was measured. */
const text = (label: string, max: number, o: { required?: boolean } = {}) =>
  z.string(`${label} must be text.`).transform((s) => cleanText(s, s.length))
    .pipe(z.string().max(max, `${label} is at most ${max} characters.`).refine((s) => !o.required || s.length > 0, `${label} cannot be empty.`));
/** An email as one address on one line: newlines and tabs are removed before anything else, so a header cannot be smuggled in with it. */
const cleanEmail = (s: string) => cleanText(s, s.length).replace(/[\r\n\t]/g, "");
/** One address (no spaces, commas, semicolons or angle brackets), or nothing. */
export const isSingleAddress = (s: string): boolean => s === "" || /^[^\s@,;<>]+@[^\s@,;<>]+$/.test(s);
const list = (label: string) => z.array(text(label, 200, { required: true })).max(10, `${label} has at most 10 items.`);

export const ChangeOrderContentSchema = z.object({
  reference: text("The reference", 60, { required: true }),
  title: text("The title", 120, { required: true }),
  summary: text("The summary", 1500),
  reason: text("The reason", 600),
  deliverables: list("A deliverable"),
  notIncluded: list("A not-included item"),
  hours: z.number("Hours must be a number.").min(0.25, "Hours are at least 0.25.").max(200, "Hours are at most 200.").refine((h) => Number.isInteger(h * 4), "Hours go in steps of 0.25."),
  rateCents: z.number("The rate must be a number.").int("The rate must be whole cents.").min(0, "The rate cannot be negative."),
  priceCents: z.number("The price must be a number.").int("The price must be whole cents.").min(1, "The price must be at least one cent."),
  scheduleImpactDays: z.number("Schedule impact must be a number of days.").int("Schedule impact must be whole days.").min(0, "Schedule impact cannot be negative.").max(180, "Schedule impact is at most 180 days.").nullable(),
  clientName: text("The client name", 120),
  contactName: text("The contact name", 120),
  contactEmail: z.string("The contact email must be text.").transform(cleanEmail)
    .pipe(z.string().max(254, "The contact email is at most 254 characters.").refine(isSingleAddress, "The contact email must be one address.")),
}).strict() satisfies z.ZodType<ChangeOrderContent>;

/** The text or numbers were refused (a 400). The message is a plain sentence; nothing was saved. */
export class ChangeOrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeOrderInputError";
  }
}
/** The change order is not in a state that allows this (a 409). The message is a plain sentence. */
export class ChangeOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeOrderStateError";
  }
}

/** The content with its text cleaned and every value checked. Throws ChangeOrderInputError (the first problem, in a plain sentence). */
export function parseContent(c: unknown): ChangeOrderContent {
  const r = ChangeOrderContentSchema.safeParse(c);
  if (!r.success) throw new ChangeOrderInputError(r.error.issues[0].message);
  return r.data;
}

export interface ChangeOrder {
  id: string; projectId: string; businessId: string; dealId: string | null; seq: number; test: boolean; status: ChangeOrderStatus; content: ChangeOrderContent;
  contentSha256: string | null; token: string | null; sourceType: ChangeOrderSource; originApprovalId: string | null; approvalId: string | null; sentAt: string | null;
  expiresAt: string | null; firstViewedAt: string | null; signedAt: string | null; signerName: string | null; signerEmail: string | null; signerIp: string | null;
  signerUserAgent: string | null; consentText: string | null; consentVersion: number | null; declinedReason: string | null; paidAt: string | null; paidVia: "stripe" | "manual" | null;
  voidReason: string | null; createdAt: string; updatedAt: string;
}

/** What the client typed or their browser sent when signing. The callers clean and cap it. */
export interface ChangeOrderSignature {
  signerName: string; signerEmail: string; signedAt: string; ip: string | null; userAgent: string | null; consentText: string; consentVersion: number; contentSha256: string;
}

/** A visitor opening the link again within this long is not a new view. */
const VIEW_GAP_MS = 10 * 60_000;

interface Row {
  id: string; project_id: string; business_id: string; deal_id: string | null; seq: number; test: number; status: ChangeOrderStatus; content: string; content_sha256: string | null;
  token: string | null; source_type: ChangeOrderSource; origin_approval_id: string | null; approval_id: string | null; sent_at: string | null; expires_at: string | null;
  first_viewed_at: string | null; signed_at: string | null; signer_name: string | null; signer_email: string | null; signer_ip: string | null; signer_user_agent: string | null;
  consent_text: string | null; consent_version: number | null; declined_reason: string | null; paid_at: string | null; paid_via: "stripe" | "manual" | null;
  void_reason: string | null; created_at: string; updated_at: string;
}

/** The content column holds what `parseContent` produced, so it is read back as is. */
const toChangeOrder = (r: Row): ChangeOrder => ({
  id: r.id, projectId: r.project_id, businessId: r.business_id, dealId: r.deal_id, seq: r.seq, test: !!r.test, status: r.status, content: JSON.parse(r.content) as ChangeOrderContent,
  contentSha256: r.content_sha256, token: r.token, sourceType: r.source_type, originApprovalId: r.origin_approval_id, approvalId: r.approval_id, sentAt: r.sent_at, expiresAt: r.expires_at,
  firstViewedAt: r.first_viewed_at, signedAt: r.signed_at, signerName: r.signer_name, signerEmail: r.signer_email, signerIp: r.signer_ip, signerUserAgent: r.signer_user_agent,
  consentText: r.consent_text, consentVersion: r.consent_version, declinedReason: r.declined_reason, paidAt: r.paid_at, paidVia: r.paid_via, voidReason: r.void_reason,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function getChangeOrder(db: D1Database, id: string): Promise<ChangeOrder | null> {
  const r = await db.prepare(`SELECT * FROM change_orders WHERE id = ?`).bind(id).first<Row>();
  return r ? toChangeOrder(r) : null;
}

export async function getChangeOrderByToken(db: D1Database, token: string): Promise<ChangeOrder | null> {
  const r = await db.prepare(`SELECT * FROM change_orders WHERE token = ?`).bind(token).first<Row>();
  return r ? toChangeOrder(r) : null;
}

/** The change order the approval drafted, if it has made one. */
export async function getChangeOrderByOrigin(db: D1Database, approvalId: string): Promise<ChangeOrder | null> {
  const r = await db.prepare(`SELECT * FROM change_orders WHERE origin_approval_id = ?`).bind(approvalId).first<Row>();
  return r ? toChangeOrder(r) : null;
}

/** A project's change orders in the order they were made. */
export async function listChangeOrders(db: D1Database, projectId: string): Promise<ChangeOrder[]> {
  return (await db.prepare(`SELECT * FROM change_orders WHERE project_id = ? ORDER BY seq`).bind(projectId).all<Row>()).results.map(toChangeOrder);
}

const isSeqConflict = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: change_orders\.project_id, change_orders\.seq/i.test(e.message);

/**
 * Makes a draft with the project's next number; the reference is `${referenceBase}-CO${seq}`. One draft per drafting approval: a second call with the same `originApprovalId`
 * finds the first and changes nothing (`created: false`). Two drafts made at once for one project can pick the same number; the loser is refused by the unique index and
 * tries again with the next one. The content is checked here (ChangeOrderInputError) and stored as the cleaned text.
 */
export async function createChangeOrderDraft(db: D1Database, o: {
  projectId: string; businessId: string; dealId: string | null; test: boolean; sourceType: ChangeOrderSource; originApprovalId: string | null;
  referenceBase: string; content: Omit<ChangeOrderContent, "reference">;
}): Promise<{ changeOrder: ChangeOrder; created: boolean }> {
  if (o.originApprovalId) {
    const first = await getChangeOrderByOrigin(db, o.originApprovalId);
    if (first) return { changeOrder: first, created: false };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = (await db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM change_orders WHERE project_id = ?`).bind(o.projectId).first<{ n: number }>())!.n;
    const content = parseContent({ ...o.content, reference: `${o.referenceBase}-CO${next}` });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      const res = await db.prepare(
        `INSERT INTO change_orders (id, project_id, business_id, deal_id, seq, test, status, content, source_type, origin_approval_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?) ON CONFLICT (origin_approval_id) DO NOTHING`,
      ).bind(id, o.projectId, o.businessId, o.dealId, next, o.test ? 1 : 0, JSON.stringify(content), o.sourceType, o.originApprovalId, now, now).run();
      if ((res.meta.changes ?? 0) === 1) return { changeOrder: (await getChangeOrder(db, id))!, created: true };
      // Only the drafting approval's own unique index can make the insert do nothing: that draft is there.
      const existing = o.originApprovalId ? await getChangeOrderByOrigin(db, o.originApprovalId) : null;
      if (!existing) throw new Error("the change order was neither created nor found");
      return { changeOrder: existing, created: false };
    } catch (e) {
      if (!isSeqConflict(e) || attempt === 4) throw e;
    }
  }
  throw new Error("could not number the change order");
}

/** Replaces a draft's content. Anything but a draft is frozen. */
export async function updateDraftContent(db: D1Database, id: string, c: ChangeOrderContent): Promise<ChangeOrder> {
  const content = parseContent(c);
  const res = await db.prepare(`UPDATE change_orders SET content = ?, updated_at = ? WHERE id = ? AND status = 'draft'`).bind(JSON.stringify(content), new Date().toISOString(), id).run();
  if ((res.meta.changes ?? 0) !== 1) throw new ChangeOrderStateError("Only a draft can be edited.");
  return (await getChangeOrder(db, id))!;
}

/**
 * Sends a draft: it becomes `sent` with the frozen content, its hash and the client's token. A retried approval (the same `approvalId` on an order already sent for it)
 * returns the order as it is; any other order that is not a draft refuses. The guard is in the statement, so two sends at once cannot both win.
 */
export async function markSent(db: D1Database, id: string, o: { token: string; content: ChangeOrderContent; contentSha256: string; sentAt: string; expiresAt: string; approvalId: string | null }): Promise<ChangeOrder> {
  const co = await getChangeOrder(db, id);
  if (!co) throw new ChangeOrderStateError("There is no such change order.");
  const retried = (c: ChangeOrder) => c.approvalId !== null && c.approvalId === o.approvalId;
  if (retried(co)) return co;
  if (co.status !== "draft") throw new ChangeOrderStateError(`A ${co.status} change order cannot be sent.`);
  const res = await db.prepare(
    `UPDATE change_orders SET status = 'sent', content = ?, content_sha256 = ?, token = ?, sent_at = ?, expires_at = ?, approval_id = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
  ).bind(JSON.stringify(parseContent(o.content)), o.contentSha256, o.token, o.sentAt, o.expiresAt, o.approvalId, o.sentAt, id).run();
  if ((res.meta.changes ?? 0) !== 1) {
    const now = await getChangeOrder(db, id);
    if (now && retried(now)) return now;
    throw new ChangeOrderStateError("The change order changed. Reload and try again.");
  }
  return (await getChangeOrder(db, id))!;
}

/**
 * Records that the client opened the link: one row, and not again within ten minutes of the last one. The first view moves `sent` to `viewed` and answers true;
 * every other call answers false. A draft has no link, and a signed, declined, void or expired order has nothing to read for, so those record nothing.
 */
export async function recordView(db: D1Database, id: string, o: { now: string; userAgent: string | null }): Promise<boolean> {
  const since = new Date(Date.parse(o.now) - VIEW_GAP_MS).toISOString();
  const res = await db.batch([
    db.prepare(
      `INSERT INTO change_order_views (id, change_order_id, viewed_at, user_agent)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM change_orders WHERE id = ? AND status IN ('sent', 'viewed'))
         AND NOT EXISTS (SELECT 1 FROM change_order_views WHERE change_order_id = ? AND viewed_at > ?)`,
    ).bind(crypto.randomUUID(), id, o.now, o.userAgent, id, id, since),
    db.prepare(`UPDATE change_orders SET status = 'viewed', first_viewed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`).bind(o.now, o.now, id),
  ]);
  return (res[1].meta.changes ?? 0) === 1;
}

/**
 * Stores the client's signature and marks the order signed, in ONE statement: the order is open (sent or viewed), not past its time, and still the content whose hash
 * the client saw. Two signs at once leave one signature (the second finds it signed). A void, expired, declined, draft or changed order is `not_open`.
 */
export async function signChangeOrder(db: D1Database, id: string, sig: ChangeOrderSignature, now: string): Promise<"signed" | "already_signed" | "not_open"> {
  const res = await db.prepare(
    `UPDATE change_orders SET status = 'signed', signed_at = ?, signer_name = ?, signer_email = ?, signer_ip = ?, signer_user_agent = ?, consent_text = ?, consent_version = ?, updated_at = ?
     WHERE id = ? AND status IN ('sent', 'viewed') AND expires_at >= ? AND content_sha256 = ?`,
  ).bind(sig.signedAt, sig.signerName, sig.signerEmail, sig.ip, sig.userAgent, sig.consentText, sig.consentVersion, now, id, now, sig.contentSha256).run();
  if ((res.meta.changes ?? 0) === 1) return "signed";
  return (await getChangeOrder(db, id))?.status === "signed" ? "already_signed" : "not_open";
}

/** The client says no, with an optional reason (cleaned, 500 characters). Only a sent or viewed order that has not run out can be declined. */
export async function declineChangeOrder(db: D1Database, id: string, reason: string, now: string): Promise<"declined" | "already_declined" | "not_open"> {
  const res = await db.prepare(
    `UPDATE change_orders SET status = 'declined', declined_reason = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'viewed') AND expires_at >= ?`,
  ).bind(cleanText(reason, 500), now, id, now).run();
  if ((res.meta.changes ?? 0) === 1) return "declined";
  return (await getChangeOrder(db, id))?.status === "declined" ? "already_declined" : "not_open";
}

/**
 * Voids a draft, sent, viewed, declined or expired change order with the reason; a void one is returned as it is. A declined or expired one can be voided too (a dead end, whose locked tasks then need clearing). A signed one refuses: a signed order is a record.
 * With `log`, the timeline line is written in the same batch and only when this call is the one that voided it.
 */
export async function voidChangeOrder(db: D1Database, id: string, reason: string, o: { log?: { businessId: string; detail: string } } = {}): Promise<ChangeOrder> {
  const update = db.prepare(`UPDATE change_orders SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'sent', 'viewed', 'declined', 'expired')`).bind(reason, new Date().toISOString(), id);
  if (o.log) await db.batch([update, activityIfChangedStmt(db, o.log.businessId, "change_order_void", o.log.detail)]);
  else await update.run();
  const co = await getChangeOrder(db, id);
  if (!co) throw new ChangeOrderStateError("There is no such change order.");
  if (co.status !== "void") throw new ChangeOrderStateError(`A ${co.status} change order cannot be voided.`);
  return co;
}

/**
 * Records the payment on a signed order and answers true only for the call that did it (the first payment time and way stand). Anything not signed answers false.
 * With `log`, the timeline line is written in the same batch and only when this call recorded the payment.
 */
export async function markPaid(db: D1Database, id: string, o: { at: string; via: "stripe" | "manual"; log?: { businessId: string; detail: string } }): Promise<boolean> {
  const update = db.prepare(`UPDATE change_orders SET paid_at = ?, paid_via = ?, updated_at = ? WHERE id = ? AND status = 'signed' AND paid_at IS NULL`).bind(o.at, o.via, o.at, id);
  if (!o.log) return ((await update.run()).meta.changes ?? 0) === 1;
  const [res] = await db.batch([update, activityIfChangedStmt(db, o.log.businessId, "change_order_paid", o.log.detail)]);
  return (res.meta.changes ?? 0) === 1;
}

/** Expires every sent or viewed order whose time has run out (before `now`: at the exact instant it is still open) and returns exactly those, so each is handled once. */
export async function expireDue(db: D1Database, now: string): Promise<ChangeOrder[]> {
  const res = await db.prepare(`UPDATE change_orders SET status = 'expired', updated_at = ? WHERE status IN ('sent', 'viewed') AND expires_at < ? RETURNING *`).bind(now, now).all<Row>();
  return res.results.map(toChangeOrder);
}

/** Removes the order's tasks that are still locked, with their notes (a draft's tasks are all new, so nothing of value goes). Returns how many tasks went. */
export async function deleteLockedTasks(db: D1Database, id: string): Promise<number> {
  const locked = `SELECT id FROM tasks WHERE change_order_id = ? AND status = 'locked' AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.task_id = tasks.id)`;
  const res = await db.batch([
    db.prepare(`DELETE FROM task_comments WHERE task_id IN (${locked})`).bind(id),
    db.prepare(`DELETE FROM tasks WHERE id IN (${locked})`).bind(id),
  ]);
  return res[1].meta.changes ?? 0;
}
