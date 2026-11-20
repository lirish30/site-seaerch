import { mainMailboxProblem } from "../booking/mail";
import { checkConflict } from "../conflict";
import { lastBookingFor } from "../db/bookings";
import { logActivityOnce } from "../db/activity";
import { getBusiness } from "../db/businesses";
import {
  ChangeOrderInputError, ChangeOrderStateError, deleteLockedTasks, isSingleAddress, getChangeOrder, getChangeOrderByOrigin, markPaid, markSent, parseContent, createChangeOrderDraft, updateDraftContent, voidChangeOrder,
  type ChangeOrder, type ChangeOrderContent, type ChangeOrderSource,
} from "../db/changeOrders";
import { getDeal } from "../db/deals";
import { getDocument } from "../db/documents";
import { getPackage } from "../db/packages";
import { getProject } from "../db/projects";
import { getSettings } from "../db/settings";
import { CREDENTIAL_REFUSED, insertTasks, listTasks, setTaskStatus, type NewTask } from "../db/tasks";
import { CLIENT_BASE_PROBLEM } from "../documents/service";
import { clientBase } from "../documents/mail";
import { legalGate, parseDocumentsConfig } from "../documents/config";
import { canonicalJson, sha256Hex } from "../documents/hash";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { sendEmail } from "../mail/send";
import { cleanText, looksLikeCredential } from "../onboarding/templates";
import { runTasksChanged } from "../projects/hooks";
import type { Settings } from "../types";
import { renderChangeOrderMail } from "./mail";

export { ChangeOrderInputError, ChangeOrderStateError };

/** The kind of the approval that mails a change order, and its payload key. Kept here so a draft's edit can withdraw it without importing the approval. */
const SEND_KIND = "change_order.send";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const DAY_MS = 86_400_000;

async function need(env: Env, id: string): Promise<ChangeOrder> {
  const co = await getChangeOrder(env.DB, id);
  if (!co) throw new ChangeOrderStateError("There is no such change order.");
  return co;
}

/** Refuses text that reads like a login or password. The text is cleaned the way it will be saved first, so a hidden character cannot hide it. */
function refuseCredentials(texts: (string | null | undefined)[]): void {
  for (const t of texts) if (t && looksLikeCredential(cleanText(t, t.length))) throw new ChangeOrderInputError(CREDENTIAL_REFUSED);
}
const contentTexts = (c: Pick<ChangeOrderContent, "title" | "summary" | "reason" | "deliverables" | "notIncluded">) => [c.title, c.summary, c.reason, ...c.deliverables, ...c.notIncluded];

/** Marks the waiting send approval for these change orders rejected: the owner approved what a draft said then, and it has changed or gone since. */
export async function withdrawSendApprovals(db: D1Database, changeOrderIds: string[], note: string): Promise<void> {
  if (changeOrderIds.length === 0) return;
  await db.batch(changeOrderIds.map((id) =>
    db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decision_note = ? WHERE kind = ? AND status = 'pending' AND json_extract(payload, '$.changeOrderId') = ?`)
      .bind(new Date().toISOString(), note, SEND_KIND, id)));
}

/** The tasks a change order makes: one per deliverable, or one named after the change order when there are none. Together they carry exactly the order's hours. */
function taskPlan(c: ChangeOrderContent): { title: string; description: string; estMinutes: number }[] {
  const items = c.deliverables.length ? c.deliverables : [c.title];
  const total = Math.round(c.hours * 60);
  const each = Math.floor(total / items.length);
  return items.map((d, i) => ({
    title: cleanText(d, 120),
    description: c.deliverables.length ? (d.length > 120 ? d : "") : c.summary.slice(0, 2000),
    estMinutes: i === 0 ? each + (total - each * items.length) : each,
  }));
}

/**
 * Makes the draft's tasks match its content: locked, billable and on the project, none of them a step (so they never finish the project nor hold a phase open). It leaves a
 * draft whose tasks already match alone, so it is safe to run again, and it heals a draft whose tasks were never made.
 */
async function syncTasks(env: Env, co: ChangeOrder): Promise<void> {
  const db = env.DB;
  const all = await listTasks(db, co.projectId);
  const mine = all.filter((t) => t.changeOrderId === co.id);
  if (mine.some((t) => t.status !== "locked")) return;
  const plan = taskPlan(co.content);
  if (mine.length === plan.length && plan.every((p, i) => mine[i].title === p.title && mine[i].estMinutes === p.estMinutes && mine[i].description === p.description)) return;
  if (mine.length) await deleteLockedTasks(db, co.id);
  const first = (mine.length ? await listTasks(db, co.projectId) : all).reduce((m, t) => Math.max(m, t.position), -1) + 1;
  const rows: NewTask[] = plan.map((p, i) => ({
    projectId: co.projectId, businessId: co.businessId, isStep: false, stepKey: null, phaseKey: "change_orders", phaseTitle: "Change orders", position: first + i, title: p.title,
    description: p.description, owner: "logan", status: "locked", doneWhen: "", estMinutes: p.estMinutes, dueOn: null, billable: true, skippable: false, requires: [], milestone: null,
    clientSummary: null, docTemplate: null, emailTemplate: null, checklist: [], changeOrderId: co.id, cadenceKey: null, periodKey: null,
  }));
  await insertTasks(db, rows);
}

/**
 * The reference without its number: the proposal's reference, then the project's template key (or its kind, for a project made by hand) cut down to letters and digits, so every project
 * of one sale has its own (SL-XXXX-BUILD-CO1, SL-XXXX-CARE0-CO1). A change order's reference is what the client reads and what the timeline lines name it by.
 */
const referenceBase = (p: { templateKey: string | null; kind: string }, proposalReference: string): string =>
  `${proposalReference}-${(p.templateKey ?? p.kind).toUpperCase().replace(/[^A-Z0-9]/g, "") || "PROJECT"}`;

/** The first eight characters of the order's id, named on every timeline line about it so two orders can never read as one (`logActivityOnce` merges identical lines). */
export const shortId = (co: { id: string }): string => co.id.slice(0, 8);

export interface DraftOptions {
  projectId: string; title: string; summary: string; reason: string; hours: number; deliverables?: string[]; notIncluded?: string[]; scheduleImpactDays?: number | null;
  priceCents?: number; rateCents?: number; sourceType: ChangeOrderSource; originApprovalId?: string;
}

/**
 * Drafts a change order on a project: the rate defaults to the current `hourly` package price and the price to `round(hours x rate)` (a price given wins). The order takes its client
 * and contact from the project's proposal (or the discovery booking), and its deal and test flag from the project. It makes one locked, billable task per deliverable (or one named after
 * the change order). Refuses a project that is done, cancelled or unknown. One draft per `originApprovalId`: a replay finds the first and repairs its tasks if they are missing.
 * Nothing is sent. The text is cleaned, and text that reads like a login or password is refused.
 */
export async function draftChangeOrder(env: Env, o: DraftOptions): Promise<ChangeOrder> {
  const db = env.DB;
  if (o.originApprovalId) {
    const first = await getChangeOrderByOrigin(db, o.originApprovalId);
    if (first) { if (first.status === "draft") await syncTasks(env, first); return first; }
  }
  const project = await getProject(db, o.projectId);
  if (!project) throw new ChangeOrderStateError("There is no such project.");
  if (project.status === "done" || project.status === "cancelled") throw new ChangeOrderStateError(`This project is ${project.status}, so it cannot take a change order.`);
  const business = await getBusiness(db, project.businessId);
  if (!business) throw new ChangeOrderStateError("This project's lead was not found.");
  if (project.dealId && !(await getDeal(db, project.dealId))) throw new ChangeOrderStateError("This project's deal was not found.");

  let rateCents = o.rateCents;
  if (rateCents === undefined) {
    const hourly = await getPackage(db, "hourly");
    if (!hourly) throw new ChangeOrderStateError("The hourly rate is missing from the package catalog.");
    rateCents = hourly.priceCents;
  }
  const doc = project.documentId ? await getDocument(db, project.documentId) : null;
  const booking = doc ? null : await lastBookingFor(db, project.businessId, "discovery");
  const content = {
    title: o.title, summary: o.summary, reason: o.reason, deliverables: o.deliverables ?? [], notIncluded: o.notIncluded ?? [], hours: o.hours, rateCents,
    priceCents: o.priceCents ?? Math.round(o.hours * rateCents), scheduleImpactDays: o.scheduleImpactDays ?? null,
    clientName: oneLine(doc?.content.header.clientName ?? business.name), contactName: doc?.content.header.contactName ?? booking?.contactName ?? "",
    contactEmail: ((e) => (isSingleAddress(e) ? e : ""))((doc?.content.header.contactEmail ?? booking?.contactEmail ?? "").replace(/[\r\n\t]/g, "").trim()),
  };
  const checked = parseContent({ ...content, reference: "CO" });
  refuseCredentials(contentTexts(checked));
  const { changeOrder } = await createChangeOrderDraft(db, {
    projectId: project.id, businessId: project.businessId, dealId: project.dealId, test: project.test, sourceType: o.sourceType, originApprovalId: o.originApprovalId ?? null,
    referenceBase: referenceBase(project, doc?.content.header.reference ?? `SL-${project.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`), content,
  });
  if (changeOrder.status === "draft") await syncTasks(env, changeOrder);
  return changeOrder;
}

/** What can change on a draft. A field left out is kept. */
export type ChangeOrderEdits = Partial<Pick<ChangeOrderContent, "title" | "summary" | "reason" | "hours" | "deliverables" | "notIncluded" | "scheduleImpactDays" | "priceCents" | "rateCents" | "contactName" | "contactEmail">>;

/**
 * Edits a draft (anything else is frozen: ChangeOrderStateError). Changing the hours or the rate re-prices it, unless the price had been set by hand (then it stays, or the
 * given one is taken). A waiting send approval is withdrawn BEFORE the content changes, so what Logan approves is what is sent. The tasks follow the deliverables.
 */
export async function editDraft(env: Env, id: string, edits: ChangeOrderEdits): Promise<ChangeOrder> {
  const co = await need(env, id);
  if (co.status !== "draft") throw new ChangeOrderStateError("Only a draft can be edited.");
  const c = co.content;
  const kept = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)) as ChangeOrderEdits;
  const hours = kept.hours ?? c.hours, rateCents = kept.rateCents ?? c.rateCents;
  const handPriced = c.priceCents !== Math.round(c.hours * c.rateCents);
  const repriced = (kept.hours !== undefined || kept.rateCents !== undefined) && !handPriced;
  const next = parseContent({ ...c, ...kept, hours, rateCents, priceCents: kept.priceCents ?? (repriced ? Math.round(hours * rateCents) : c.priceCents) });
  refuseCredentials(contentTexts(next));
  await withdrawSendApprovals(env.DB, [id], "the change order was edited after it was sent for approval");
  const saved = await updateDraftContent(env.DB, id, next);
  await syncTasks(env, saved);
  return saved;
}

/**
 * Voids a draft, sent or viewed change order (a signed one is a record: ChangeOrderStateError) and withdraws a send approval still waiting. Its locked and to-do tasks are skipped, each
 * with a system note written in the same batch as the status change. Repeating it repairs a void that died half-way (the order stays void and the remaining tasks are skipped).
 */
export async function voidDraftOrSent(env: Env, id: string, reason: string, now: Date = new Date()): Promise<ChangeOrder> {
  const why = cleanText(reason, reason.length);
  if (why.length < 3 || why.length > 300) throw new ChangeOrderInputError("A reason for voiding is 3 to 300 characters.");
  refuseCredentials([why]);
  const co = await need(env, id);
  await withdrawSendApprovals(env.DB, [id], "the change order was voided");
  const voided = await voidChangeOrder(env.DB, id, why, { log: { businessId: co.businessId, detail: `${co.content.reference} (${shortId(co)}) voided: ${why}`.slice(0, 300) } });
  let skipped = 0;
  for (const t of (await listTasks(env.DB, co.projectId)).filter((x) => x.changeOrderId === id && (x.status === "locked" || x.status === "todo"))) {
    if (await setTaskStatus(env.DB, t.id, "skipped", { from: ["locked", "todo"], now: now.toISOString(), comment: { author: "system", body: `Skipped: the change order was voided (${why})` } })) skipped++;
  }
  if (skipped) await runTasksChanged(env, co.projectId);
  return voided;
}

/**
 * When the order is signed AND paid, its locked tasks become to do (each with a system note, written in the same batch as the change) and the project's tasks-changed hooks run.
 * Idempotent: the change is guarded on the task still being locked, so a replay, or two callers at once, unlock each task once. Returns how many this call unlocked.
 * Anything else (not signed, not paid, void, expired) unlocks nothing. A database error propagates; a hook's own error is swallowed (hooks.ts).
 */
export async function unlockIfReady(env: Env, id: string, now: Date): Promise<number> {
  const co = await getChangeOrder(env.DB, id);
  if (!co || co.status !== "signed" || co.paidAt === null) return 0;
  let n = 0;
  for (const t of (await listTasks(env.DB, co.projectId)).filter((x) => x.changeOrderId === id && x.status === "locked")) {
    if (await setTaskStatus(env.DB, t.id, "todo", { from: ["locked"], now: now.toISOString(), comment: { author: "system", body: "Unlocked: the change order is signed and paid." } })) n++;
  }
  if (n) await runTasksChanged(env, co.projectId);
  return n;
}

/**
 * Records the payment on a signed change order (Plan 8's Stripe webhook and Logan's "Mark paid" both come here) and unlocks its tasks. Refuses an order that is not signed (a 409).
 * Idempotent: the payment and its timeline line are one batch that only the first call makes, and every call (replays included) runs `unlockIfReady`, so a call that died after
 * recording the payment is repaired by repeating it.
 */
export async function markChangeOrderPaid(env: Env, id: string, o: { via: "stripe" | "manual"; now: Date }): Promise<ChangeOrder> {
  const co = await need(env, id);
  if (co.status !== "signed") throw new ChangeOrderStateError(co.status === "draft" || co.status === "sent" || co.status === "viewed" ? "This change order has not been signed yet, so it cannot be marked paid." : `A ${co.status} change order cannot be marked paid.`);
  await markPaid(env.DB, id, { at: o.now.toISOString(), via: o.via, log: { businessId: co.businessId, detail: `${co.content.reference} (${shortId(co)}) paid (${o.via === "stripe" ? "Stripe" : "outside Stripe"})` } });
  await unlockIfReady(env, id, o.now);
  return need(env, id);
}

/**
 * Called after the client signs (the signing route's job, once `signChangeOrder` answers signed or already_signed): logs `change_order_signed` once (a single insert-if-absent, so a replay
 * logs nothing) and unlocks the tasks if the order is already paid. An order that is not signed does nothing.
 */
export async function afterSigned(env: Env, id: string, now: Date): Promise<void> {
  const co = await getChangeOrder(env.DB, id);
  if (!co || co.status !== "signed") return;
  await logActivityOnce(env.DB, co.businessId, "change_order_signed", `${co.content.reference} (${shortId(co)}) signed by ${oneLine(co.signerName ?? "").slice(0, 80)}`);
  await unlockIfReady(env, id, now);
}

/** The client's link to a sent change order, or null when it has no token yet or the client link base is not set. */
export function changeOrderLink(env: Env, co: ChangeOrder): string | null {
  const base = clientBase(env);
  return base && co.token ? `${base}/c/${co.token}` : null;
}

/** A change order as the owner's screens get it: the client's link in place of the bare token, and none of what the signer's browser sent (address, browser, consent text). */
export type OwnerChangeOrder = Omit<ChangeOrder, "token" | "signerIp" | "signerUserAgent" | "consentText"> & { link: string | null };

/** The owner's view of an order. `link` is the full client URL for a sent or viewed order (the one the owner can copy), null for any other. */
export function ownerChangeOrder(env: Env, co: ChangeOrder): OwnerChangeOrder {
  const { token: _token, signerIp: _ip, signerUserAgent: _userAgent, consentText: _consent, ...rest } = co;
  return { ...rest, link: co.status === "sent" || co.status === "viewed" ? changeOrderLink(env, co) : null };
}

/**
 * Why a send is refused, in the order Logan would fix them. A REAL order needs the lawyer's review recorded (`legalGate`, exactly as a proposal does), a contact the conflict gate allows
 * and a contact email; a TEST order goes to the owner only and needs the owner's email instead. Always: the order is a draft (or this same approval's retry), the main mailbox can send,
 * the client link base is set and the project is still open.
 */
export async function sendProblems(env: Env, co: ChangeOrder, o: { approvalId?: string } = {}): Promise<string[]> {
  const db = env.DB;
  const problems: string[] = [];
  const settings = await getSettings(db);
  if (!co.test) {
    const gate = legalGate(parseDocumentsConfig(settings.documents_config));
    if (gate) problems.push(gate);
    // The owner's approval countersigns the order in these names, so neither may be blank.
    if (!settings.your_name.trim()) problems.push("Add your name in Settings before sending: it is your signature on the change order.");
    if (!settings.contact_email.trim()) problems.push("Add your contact email in Settings before sending: it is your signature on the change order.");
  }
  const retry = !!o.approvalId && co.approvalId === o.approvalId && (co.status === "sent" || co.status === "viewed" || co.status === "signed");
  if (co.status !== "draft" && !retry) problems.push(`This change order is ${co.status}, not a draft.`);
  const mailbox = await mainMailboxProblem(env);
  if (mailbox) problems.push(`The main mailbox cannot send: ${mailbox}`);
  if (!clientBase(env)) problems.push(CLIENT_BASE_PROBLEM);
  const project = await getProject(db, co.projectId);
  if (!project) problems.push("This change order's project was not found.");
  else if (!retry && (project.status === "done" || project.status === "cancelled")) problems.push(`The project is ${project.status}, so a change order cannot go out on it.`);
  if (co.test) {
    if (!settings.contact_email.trim()) problems.push("Add your contact email in Settings first: the test goes to it.");
  } else if (!co.content.contactEmail.includes("@")) problems.push("This change order has no contact email.");
  else {
    const conflict = await checkConflict(db, { email: co.content.contactEmail, businessId: co.businessId });
    if (conflict.blocked) problems.push(`Blocked: ${conflict.reason}`);
  }
  return problems;
}

/** Stamps a draft as sent: a fresh link token, its content frozen and hashed, and the day it lapses (`documents_config.expiryDays` from now), in one step. */
export async function sealChangeOrder(env: Env, co: ChangeOrder, o: { now: Date; approvalId: string | null; settings: Settings }): Promise<ChangeOrder> {
  const config = parseDocumentsConfig(o.settings.documents_config);
  const contentSha256 = await sha256Hex(canonicalJson(co.content));
  return markSent(env.DB, co.id, {
    token: newClientToken(), content: co.content, contentSha256, sentAt: o.now.toISOString(), expiresAt: new Date(o.now.getTime() + config.expiryDays * DAY_MS).toISOString(), approvalId: o.approvalId,
  });
}

/** Where the mail goes and what it says. A test order is a message to the owner and only the owner: the contact on the order is never written to, and its subject starts "[Test] ". */
export function mailFor(env: Env, co: ChangeOrder, settings: Settings): { to: string; subject: string; body: string; link: string } {
  const link = changeOrderLink(env, co) ?? `${clientBase(env) ?? "(set CLIENT_LINK_BASE first)"}/c/(the link is made when you approve)`;
  const m = renderChangeOrderMail(co, link, settings);
  return { to: (co.test ? settings.contact_email : co.content.contactEmail).replace(/[\r\n\t]/g, "").trim(), subject: co.test ? `[Test] ${m.subject}` : m.subject, body: m.body, link };
}

/**
 * Mails the link of a sent order from the main mailbox. The approval id is the once-only key (a retried approval cannot send twice); the checks a real send makes are
 * `sendProblems`' to make first, so this goes with `skipLimits`. A test order goes without a lead on it, as a test proposal does.
 */
export async function mailChangeOrderLink(env: Env, co: ChangeOrder, settings: Settings, approvalId: string): Promise<string> {
  if (!changeOrderLink(env, co)) throw new Error(CLIENT_BASE_PROBLEM);
  const m = mailFor(env, co, settings);
  await sendEmail(env, { mailbox: "main", to: m.to, subject: m.subject, body: m.body, includeFooter: false, ...(co.test ? {} : { businessId: co.businessId }) }, { approvalId, skipLimits: true });
  return m.to;
}
