import type { ClientRecord, ClientRow } from "../../clients/record";
import type { AgentAction } from "../../db/agentActions";
import type { Approval } from "../../db/approvals";
import type { ChangeOrder } from "../../db/changeOrders";
import type { Deal } from "../../db/deals";
import type { InvoiceRow } from "../../db/invoices";
import type { Meeting } from "../../db/meetings";
import type { Project } from "../../db/projects";
import type { AccessItem, Site } from "../../db/sites";
import type { Task } from "../../db/tasks";
import { ACCESS_LABELS } from "../../sites/access";
import type { Activity } from "../../types";

/**
 * What the MCP tools answer with. Every view is a hand-built list of fields, never a spread of a row, so a column added to a table later cannot reach an agent by accident.
 * Never in any view: a vault item name or access note, a client's own answer to an access question, a token (subscription, document, booking cancel, onboarding, report,
 * change order), a Stripe id or hosted invoice URL, Meetily's transcript key, a mailbox password. A transcript only comes in `meetingView` when the caller passes its text.
 */

/** The most transcript characters one `get_meeting` answer carries. */
export const TRANSCRIPT_CAP = 20_000;

/** The first path segment of every client link the app mints (`PUBLIC_PAGE_PREFIXES` in mail/send.ts: report, proposal, onboarding, change order, subscription), and the report media route. */
const LINK_PREFIXES = new Set(["r", "p", "o", "c", "s", "report"]);
const AFTER_PREFIX = /^[A-Za-z0-9_.~-]{8,}$/;
/** A run of 20 or more URL-safe characters is a token whatever precedes it. */
const LONG_TOKEN = /^[A-Za-z0-9_-]{20,}$/;
const SECRET_PARAM = /token|cancel|key|sig|code|secret/i;

function redactPath(path: string): string {
  const segs = path.split("/");
  return segs.map((seg, i) => (LONG_TOKEN.test(seg) || (i > 0 && LINK_PREFIXES.has(segs[i - 1]) && AFTER_PREFIX.test(seg)) ? "[link]" : seg)).join("/");
}

function redactUrl(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return url;
  const [, host, path = "", query = "", hash = ""] = m;
  // A Stripe hosted page is reached by its path alone.
  const safePath = /stripe\.com$/i.test(host) && path.length > 1 ? "/[link]" : redactPath(path);
  const safeQuery = query
    ? "?" + query.slice(1).split("&").map((kv) => { const [k, ...v] = kv.split("="); return v.length && (SECRET_PARAM.test(k) || LONG_TOKEN.test(v.join("="))) ? `${k}=[link]` : kv; }).join("&")
    : "";
  return `${host}${safePath}${safeQuery}${hash ? "#[link]" : ""}`;
}

/**
 * Text that may quote a client link (an approval's preview is the mail it will send): every URL keeps its host and its prefix but loses its token (`/o/[link]`), whichever
 * link it is, and a bare `/o/<token>` path goes too. The ONE redaction every tool that shows such text uses.
 */
export function redactLinks(text: string): string {
  return text
    // Punctuation that ends a sentence or a list item is not part of the link: cut it off first, so the last segment is the bare token, and put it back after.
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => { const tail = /[.,;:!*?]+$/.exec(url)?.[0] ?? ""; return redactUrl(tail ? url.slice(0, -tail.length) : url) + tail; })
    .replace(/(^|[\s(])\/(r|p|o|c|s)\/([A-Za-z0-9_.~-]{8,})/g, (m, lead: string, prefix: string, token: string) => {
      const tail = /\.+$/.exec(token)?.[0] ?? ""; // a full stop after the path ends the sentence
      return token.length - tail.length < 8 ? m : `${lead}/${prefix}/[link]${tail}`;
    });
}

export const activityView = (a: Activity) => ({ id: a.id, kind: a.kind, detail: a.detail === null ? null : redactLinks(a.detail), createdAt: a.created_at });

/** An approval as an agent reads it: what it is and where it stands, and its preview with every client link token redacted. Never the payload, the error or the decision note. */
export const approvalView = (a: Approval) => ({
  id: a.id, kind: a.kind, title: redactLinks(a.title), preview: redactLinks(a.preview), status: a.status, record_type: a.record_type, record_id: a.record_id,
  drafted_by: a.drafted_by, created_at: a.created_at, decided_at: a.decided_at,
});

export const agentActionView = (a: AgentAction) => ({
  id: a.id, actor: a.actor, tool: a.tool, summary: redactLinks(a.summary), recordType: a.record_type, recordId: a.record_id, createdAt: a.created_at,
});

/** A site and its six access lines as `{ key, label, status }`: the vault item name and the note stay in the app. */
export const siteView = (site: Site, items: AccessItem[]) => ({
  id: site.id, businessId: site.businessId, url: site.url, domain: site.domain, cms: site.cms, hostProvider: site.hostProvider, registrar: site.registrar,
  dnsProvider: site.dnsProvider, adminUrl: site.adminUrl, hostingTier: site.hostingTier, accessMethod: site.accessMethod, test: site.test, archivedAt: site.archivedAt,
  access: items.map((i) => ({ key: i.key, label: ACCESS_LABELS[i.key].label, status: i.status })),
});

export const projectView = (p: Project & { businessName?: string; openTasks?: number; doneTasks?: number; openSteps?: number; doneSteps?: number }) => ({
  id: p.id, businessId: p.businessId, businessName: p.businessName ?? null, dealId: p.dealId, kind: p.kind, name: p.name, status: p.status, pausedReason: p.pausedReason,
  test: p.test, startedAt: p.startedAt, completedAt: p.completedAt, openTasks: p.openTasks ?? null, doneTasks: p.doneTasks ?? null, openSteps: p.openSteps ?? null, doneSteps: p.doneSteps ?? null,
});

export const taskView = (t: Task & { projectName?: string; businessName?: string }) => ({
  id: t.id, projectId: t.projectId, projectName: t.projectName ?? null, businessId: t.businessId, businessName: t.businessName ?? null, title: t.title, status: t.status,
  owner: t.owner, phase: t.phaseTitle, dueOn: t.dueOn, estMinutes: t.estMinutes, doneWhen: t.doneWhen, milestone: t.milestone,
});

export const changeOrderView = (c: ChangeOrder) => ({
  id: c.id, projectId: c.projectId, businessId: c.businessId, seq: c.seq, status: c.status, title: c.content.title, reference: c.content.reference, priceCents: c.content.priceCents,
  test: c.test, sentAt: c.sentAt, signedAt: c.signedAt, paidAt: c.paidAt, createdAt: c.createdAt,
});

export const dealView = (d: Deal & { businessName?: string }) => ({
  id: d.id, businessId: d.businessId, businessName: d.businessName ?? null, stage: d.stage, source: d.source, skipCall: d.skipCall, valueCents: d.valueCents,
  recommendedOptionId: d.recommendedOptionId, lostReason: d.lostReason, deckFrozenAt: d.deckFrozenAt, createdAt: d.createdAt, updatedAt: d.updatedAt, closedAt: d.closedAt,
  options: d.options && d.options.map((o) => ({
    id: o.id, label: o.label, tagline: o.tagline, recommended: o.recommended, items: o.items.map((i) => ({ key: i.key, setupDiscountCents: i.setupDiscountCents ?? 0 })),
  })),
  recap: d.recap && {
    playback: d.recap.playback, recommendation: d.recap.recommendation, leadType: d.recap.leadType, goals: d.recap.goals, currentState: d.recap.currentState, generatedAt: d.recap.generatedAt,
  },
});

/** An invoice without its Stripe ids, its hosted link or its idempotency ref: what is owed, for what, and where it stands. */
export const invoiceView = (i: InvoiceRow) => ({
  id: i.id, businessId: i.businessId, dealId: i.dealId, projectId: i.projectId, changeOrderId: i.changeOrderId, subscriptionId: i.subscriptionId, kind: i.kind, test: i.test,
  description: i.description, lines: i.lines.map((l) => ({ description: l.description, amountCents: l.amountCents })), amountCents: i.amountCents, status: i.status,
  dueOn: i.dueOn, sentAt: i.sentAt, failedOn: i.failedOn, paidAt: i.paidAt, createdAt: i.createdAt,
});

/** A meeting with its summary. Meetily's notes come only when asked for, and the transcript only when its text is passed (cut at `TRANSCRIPT_CAP`). Never the transcript's storage key. */
export function meetingView(m: Meeting, o: { transcript?: string; notes?: boolean } = {}) {
  const s = m.summary;
  return {
    id: m.id, businessId: m.businessId, bookingId: m.bookingId, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, status: m.status,
    followupSentAt: m.followupSentAt, createdAt: m.createdAt, summarizedAt: m.summarizedAt,
    summary: s && {
      summary: s.summary, decisions: s.decisions, generatedAt: s.generatedAt,
      actionItems: s.actionItems.map((a) => ({ title: a.title, owner: a.owner, dueOn: a.dueOn })),
      possibleChangeOrders: s.possibleChangeOrders.map((c) => ({ title: c.title, summary: c.summary, reason: c.reason, hours: c.hours })),
      followUp: { subject: s.followUp.subject, body: s.followUp.body },
    },
    ...(o.notes ? { notes: m.notes } : {}),
    ...(o.transcript !== undefined ? { transcript: o.transcript.slice(0, TRANSCRIPT_CAP), transcriptTruncated: o.transcript.length > TRANSCRIPT_CAP } : {}),
  };
}

/** One row of the client search: the list numbers, plus the domains of the client's live sites. */
export const clientRowView = (r: ClientRow, domains: string[]) => ({
  id: r.id, name: r.name, careLabel: r.careLabel, mrrCents: r.mrrCents, siteCount: r.siteCount, domains, accessMissing: r.accessMissing, openInvoiceCents: r.openInvoiceCents,
  held: r.held, nextRenewalOn: r.nextRenewalOn, grade: r.grade.grade, suggestedGrade: r.grade.suggested,
});

/** The whole client for an agent: the owner's record with every vault name, access note, client answer and token left out. Activity is the newest 20. */
export function clientView(r: ClientRecord) {
  const b = r.business;
  return {
    id: b.id, name: b.name, category: b.category, address: b.address, phone: b.phone, website: b.website_url, leadStatus: b.lead_status, dealValue: b.deal_value, notes: b.notes,
    people: r.people.map((p) => ({ id: p.id, name: p.name, role: p.role, email: p.email, phone: p.phone, isPoc: p.is_poc })),
    sites: r.sites.map((s) => ({ ...siteView(s.site, s.access), flags: s.flags.map((f) => ({ code: f.code, text: f.text })) })),
    subscriptions: r.subscriptions.map((s) => ({
      id: s.id, packageKey: s.packageKey, status: s.status, monthlyCents: s.monthlyCents, firstChargeOn: s.firstChargeOn, termEndsOn: s.termEndsOn, test: s.test,
      activatedAt: s.activatedAt, cancelledAt: s.cancelledAt,
    })),
    mrrCents: r.mrrCents, careLabel: r.careLabel, nextRenewalOn: r.nextRenewalOn, held: r.held,
    grade: { grade: r.grade.grade, note: r.grade.note, setAt: r.grade.setAt, suggested: r.grade.suggested, reasons: r.grade.reasons },
    projects: r.projects.map(projectView),
    invoices: { openCents: r.invoices.openCents, overdueCount: r.invoices.overdueCount, paidCents: r.invoices.paidCents },
    documents: r.documents.map((d) => ({ id: d.id, dealId: d.dealId, version: d.version, status: d.status, test: d.test, reference: d.reference, sentAt: d.sentAt, signedAt: d.signedAt, paidAt: d.paidAt })),
    changeOrders: r.changeOrders.map((c) => ({ id: c.id, projectId: c.projectId, status: c.status, title: c.title, reference: c.reference, priceCents: c.priceCents, test: c.test, signedAt: c.signedAt, paidAt: c.paidAt })),
    activity: r.activity.slice(0, 20).map(activityView),
  };
}
