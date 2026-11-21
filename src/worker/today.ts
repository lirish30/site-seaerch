import { chunks } from "./db/chunks";
import { listTodayCandidates } from "./db/businesses";
import { suppressedLeadIds } from "./db/suppression";
import { openProposalsSentBefore } from "./db/documents";
import { listOpenItems, listOpenOnboardings } from "./db/onboardings";
import { isWaitingOnClient, silentDays } from "./onboarding/schedule";
import { projectAttention } from "./projects/progress";
import { calendarDateIn, calendarDaysBetween } from "./billing/dates";
import { activeHolds } from "./db/holds";
import { listInvoices } from "./db/invoices";
import { getSettings } from "./db/settings";
import { zoneOf } from "./sop/cadence";
import { ACCESS_KEYS, type AccessStatus } from "./db/sites";
import { liveProjectSql } from "./db/projects";
import { clientSql, testClientSql } from "./clients/record";
import { ACCESS_LABELS, unresolved } from "./sites/access";
import { CARE_SUBSCRIPTION_SQL, listIncidents, type Incident } from "./db/monitoring";
import { editLedger } from "./care/ledger";
import { localDay } from "./monitoring/rollup";
import { lastRunsFor } from "./db/careUpdates";
import { UPDATE_DETAIL, isStillBroken } from "./care/incidents";
import { domainDaysLeft } from "./monitoring/incidents";

export const TODAY_KINDS = ["follow_up_due", "draft_unsent", "stalled_deal", "starred_idle", "promising_quick_scan", "proposal_follow_up", "onboarding_attention", "project_attention", "billing_attention", "access_missing", "site_incident", "care_edit_hours"] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];
export const isTodayKind = (s: string): s is TodayKind => (TODAY_KINDS as readonly string[]).includes(s);

export interface TodayItem {
  /** `${kind}:${businessId}` */
  id: string; kind: TodayKind; businessId: string; businessName: string; reason: string;
  /** ISO time the item became due (follow-ups only), else null. */
  due: string | null; priority: number;
}

const DAY = 86_400_000;
export const DONE_HIDES_DAYS = 7, STALLED_DAYS = 14, DRAFT_UNSENT_DAYS = 2, ACCESS_WAIT_DAYS = 3, STARRED_IDLE_DAYS = 7, PROPOSAL_FOLLOW_UP_DAYS = 3, WELCOME_WAITING_DAYS = 1, MIN_QUICK_SCORE = 50, MAX_QUICK_ITEMS = 5, MAX_OVERDUE_BONUS = 30;
// Activity older than this can no longer affect a result (done 7d, stalled 14d, snooze at most 30d), except `export`, which has no age limit.
const ACTIVITY_WINDOW_DAYS = 30;

// Done and snooze are logged in the activity log, one row per click, and read back here.
//   today_done  detail = the item kind                     (hides that kind for DONE_HIDES_DAYS from the row's time)
//   snoozed     detail = `${kind}|${untilIsoTimestamp}`    (hides that kind until the timestamp)
// For a given (lead, kind) the most recent of these rows decides, so snoozing again or marking done overrides an earlier one.
export const snoozeDetail = (kind: TodayKind, until: Date) => `${kind}|${until.toISOString()}`;

/** Reads a `snoozed` row's detail. Anything malformed gives null, which hides nothing. */
export function parseSnooze(detail: string | null): { kind: TodayKind; until: number } | null {
  const i = detail?.indexOf("|") ?? -1;
  if (!detail || i < 0) return null;
  const kind = detail.slice(0, i), until = Date.parse(detail.slice(i + 1));
  return isTodayKind(kind) && Number.isFinite(until) ? { kind, until } : null;
}

// Rows written by the Today queue or by bulk edits are not contact with the prospect, so they must not un-stall a deal.
// job_found rows were written by the removed job watch; old ones still must not count as contact.
// deal_created, deal_moved, call_prep, call_recap and followup_booked are the owner filing a deal (or the queue prepping or recapping a call), not contact with the prospect.
// meeting_recorded is the sync filing a recording a day or so later, not contact made now.
// video_watch is deliberately NOT in this set: a prospect watching the video is engagement and does un-stall a deal.
const NOT_CONTACT = new Set(["today_done", "snoozed", "bulk", "starred", "unstarred", "job_found", "deal_created", "deal_moved", "call_prep", "call_recap", "followup_booked", "site_down", "site_back", "domain_expiring", "proposal_viewed", "proposal_signed", "proposal_void", "deposit_paid",
  "project_started", "project_milestone", "project_done", "change_order_sent", "change_order_signed", "change_order_paid", "change_order_void", "change_order_declined", "invoice_sent", "invoice_paid", "billing_hold_placed", "meeting_recorded"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-02" as "2 Oct". */
const dayMonth = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;

/**
 * What needs Logan about a client's money, one reason per client, the worst state first: (1) work on hold (since the day it was placed), (2) an invoice past its due date (the oldest one speaks,
 * counted from the day a payment failed, else from the due date, as the reminders are), (3) an invoice drafted and waiting for his OK to send. Test invoices never count.
 */
async function billingAttention(db: D1Database, now: Date): Promise<Map<string, { reason: string; priority: number }>> {
  const out = new Map<string, { reason: string; priority: number }>();
  const tz = zoneOf(await getSettings(db));
  const today = calendarDateIn(now, tz);
  for (const h of await activeHolds(db)) {
    if (!out.has(h.businessId)) out.set(h.businessId, { reason: `Work on hold since ${dayMonth(calendarDateIn(new Date(h.placedAt), tz))}`, priority: 90 });
  }
  const worst = new Map<string, number>();
  for (const i of await listInvoices(db, { statuses: ["open", "failed"] })) {
    const base = i.failedOn ?? i.dueOn;
    if (i.test || !base || base >= today) continue;
    worst.set(i.businessId, Math.max(worst.get(i.businessId) ?? 0, calendarDaysBetween(base, today)));
  }
  for (const [id, days] of worst) if (!out.has(id)) out.set(id, { reason: `Invoice ${plural(days, "day")} overdue`, priority: 75 });
  for (const i of await listInvoices(db, { statuses: ["draft"] })) {
    if (!i.test && !out.has(i.businessId)) out.set(i.businessId, { reason: "Invoice drafted: needs your OK to send", priority: 66 });
  }
  return out;
}

/**
 * A client whose site access is still not in, one reason per client: a client (not a test one) with a live, real project that started at least ACCESS_WAIT_DAYS ago and a live, real site
 * with items not yet received, verified or not applicable. Two sites with gaps give one row naming every missing label once, in checklist order. Only the fixed labels are named, never a
 * vault name, note or answer. One join; instants compare as UTC ISO text, so no calendar zone is involved.
 */
async function accessAttention(db: D1Database, now: Date): Promise<Map<string, { reason: string; priority: number }>> {
  const cutoff = new Date(now.getTime() - ACCESS_WAIT_DAYS * DAY).toISOString();
  const rows = (await db.prepare(
    `SELECT DISTINCT s.business_id AS business_id, i.key AS key, i.status AS status
     FROM sites s
     JOIN site_access_items i ON i.site_id = s.id
     JOIN businesses b ON b.id = s.business_id
     WHERE s.archived_at IS NULL AND s.test = 0 AND ${clientSql("b")} AND NOT ${testClientSql("b")}
       AND EXISTS (SELECT 1 FROM projects p WHERE p.business_id = s.business_id AND p.test = 0 AND ${liveProjectSql("p")} AND p.started_at <= ?)`,
  ).bind(cutoff).all<{ business_id: string; key: (typeof ACCESS_KEYS)[number]; status: AccessStatus }>()).results;
  const missing = new Map<string, Set<string>>();
  for (const r of unresolved(rows)) (missing.get(r.business_id) ?? missing.set(r.business_id, new Set()).get(r.business_id)!).add(r.key);
  const out = new Map<string, { reason: string; priority: number }>();
  for (const [id, keys] of missing) out.set(id, { reason: `Access still missing: ${ACCESS_KEYS.filter((k) => keys.has(k)).map((k) => ACCESS_LABELS[k].label).join(", ")}`, priority: 65 });
  return out;
}

/**
 * A Care client's edit hours running out, one row per client for the current month in the booking zone: from 80% of the allowance up the row is priority 60, past it 64.
 * Only real clients with a live Care plan; a test client never shows. The owner's own work, so it stays for a suppressed lead.
 */
async function editHoursAttention(db: D1Database, now: Date): Promise<Map<string, { percent: number | null; priority: number }>> {
  const out = new Map<string, { percent: number | null; priority: number }>();
  const ids = (await db.prepare(
    `SELECT b.id AS id FROM businesses b
     WHERE b.archived_at IS NULL AND ${CARE_SUBSCRIPTION_SQL("b")} AND NOT ${testClientSql("b")}
       AND EXISTS (SELECT 1 FROM tasks t JOIN time_entries e ON e.task_id = t.id WHERE t.business_id = b.id AND t.edit_request = 1)`,
  ).all<{ id: string }>()).results;
  if (!ids.length) return out;
  const tz = zoneOf(await getSettings(db));
  const month = localDay(now.toISOString(), tz).slice(0, 7);
  for (const { id } of ids) {
    const l = await editLedger({ DB: db }, id, month, tz);
    if (l && l.state !== "ok") out.set(id, { percent: l.percent, priority: l.state === "over" ? 64 : 60 });
  }
  return out;
}

/** "47 minutes", "1 hour 5 minutes", "2 hours", then whole days from 24 hours on. Under a minute is "less than a minute". */
export function outageLength(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  if (minutes < 24 * 60) return `${plural(Math.floor(minutes / 60), "hour")}${minutes % 60 ? ` ${plural(minutes % 60, "minute")}` : ""}`;
  return plural(Math.floor(minutes / (24 * 60)), "day");
}

/**
 * A client's site that is down or whose domain is about to lapse, one row per client: a site that is down (priority 90) beats a domain close to expiring (66). Only open incidents on live,
 * real sites of real clients (listIncidents already leaves out test clients and test sites). It is the owner's own work, so it stays for a suppressed lead.
 * The reason is built here from our own numbers (the open time, the site's expiry date) and never from `incident.detail`: that text is frozen when the incident opens, so a domain count would go stale,
 * and it is never shown. The one exception: an `update_failed` whose (whitelisted) detail is the still-broken-after-rollback sentence picks its own fixed reason, still built only from the domain. With several sites down the one down longest is named and the others counted. `openedAt` is when the client's newest open incident opened.
 */
async function incidentAttention(db: D1Database, now: Date): Promise<Map<string, { reason: string; priority: number; openedAt: number }>> {
  const incidents = await listIncidents(db, { open: true, limit: 1000 });
  const out = new Map<string, { reason: string; priority: number; openedAt: number }>();
  const looks = await pendingLooks(db, now);
  if (!incidents.length && !looks.size) return out;
  const sites = new Map<string, { domain: string | null; expiresOn: string | null; certExpiresOn: string | null }>();
  for (const part of chunks([...new Set(incidents.map((i) => i.siteId))])) {
    const rows = (await db.prepare(`SELECT id, domain, domain_expires_on, cert_expires_on FROM sites WHERE archived_at IS NULL AND id IN (${part.map(() => "?").join(",")})`).bind(...part)
      .all<{ id: string; domain: string | null; domain_expires_on: string | null; cert_expires_on: string | null }>()).results;
    for (const r of rows) sites.set(r.id, { domain: r.domain, expiresOn: r.domain_expires_on, certExpiresOn: r.cert_expires_on });
  }
  const zone = zoneOf(await getSettings(db));
  const byClient = new Map<string, Incident[]>();
  for (const i of incidents) if (sites.has(i.siteId)) (byClient.get(i.businessId) ?? byClient.set(i.businessId, []).get(i.businessId)!).push(i);
  // The newest run of a site whose update failed: did it roll back?
  const failedSites = [...new Set(incidents.filter((i) => i.kind === "update_failed" && sites.has(i.siteId)).map((i) => i.siteId))];
  const lastRuns = await lastRunsFor(db, failedSites);
  for (const businessId of new Set([...byClient.keys(), ...looks.keys()])) {
    const list = byClient.get(businessId) ?? [];
    // Done and snooze answer the incidents that were open when they were pressed, so the row also carries when the newest open one opened (see `hidden`).
    const openedAt = Math.max(...list.map((i) => ms(i.openedAt)), looks.get(businessId) ?? -Infinity);
    const name = (i: Incident) => sites.get(i.siteId)!.domain ?? "A site"; // never an address: a URL can carry a login
    // The highest priority speaks; on a tie the one listed first.
    const found: { reason: string; priority: number }[] = [];
    const downs = list.filter((i) => i.kind === "down").sort((a, c) => ms(a.openedAt) - ms(c.openedAt));
    if (downs.length) {
      const others = downs.length - 1;
      const tail = others === 0 ? "" : `, and ${others} other ${others === 1 ? "site is" : "sites are"} down too`;
      found.push({ reason: `${name(downs[0])} has been down for ${outageLength(now.getTime() - ms(downs[0].openedAt))}${tail}`, priority: 90 });
    }
    const fails = list.filter((i) => i.kind === "update_failed").sort((a, c) => ms(a.openedAt) - ms(c.openedAt));
    if (fails.length) {
      const f = fails[0];
      const reason = UPDATE_DETAIL.test(f.detail) && isStillBroken(f.detail) ? `${name(f)} is still broken after rollback`
        : lastRuns.get(f.siteId)?.status === "rolled_back" ? `updates broke ${name(f)}: rolled back` : `updates need a look on ${name(f)}`;
      found.push({ reason, priority: 85 });
    }
    if (looks.has(businessId)) found.push({ reason: "a page changed after updates and is waiting for a look", priority: 70 });
    // The nearest expiry speaks.
    const withDays = list.filter((i) => i.kind === "domain_expiring").map((i) => ({ i, days: sites.get(i.siteId)!.expiresOn ? domainDaysLeft(sites.get(i.siteId)!.expiresOn!, now, zone) : null }));
    if (withDays.length) {
      withDays.sort((a, c) => (a.days ?? Infinity) - (c.days ?? Infinity));
      const { i, days } = withDays[0];
      found.push({
        reason: days === null ? `${name(i)} domain is close to expiring`
          : days < 0 ? `${name(i)} expired ${plural(-days, "day")} ago`
          : days === 0 ? `${name(i)} expires today`
          : `${name(i)} expires in ${plural(days, "day")}`,
        priority: 66,
      });
    }
    const certs = list.filter((i) => i.kind === "cert_expiring").map((i) => ({ i, days: sites.get(i.siteId)!.certExpiresOn ? domainDaysLeft(sites.get(i.siteId)!.certExpiresOn!, now, zone) : null }));
    if (certs.length) {
      certs.sort((a, c) => (a.days ?? Infinity) - (c.days ?? Infinity));
      const { i, days } = certs[0];
      found.push({
        reason: days === null ? `${name(i)}'s certificate is close to expiring`
          : days < 0 ? `${name(i)}'s certificate expired ${plural(-days, "day")} ago`
          : days === 0 ? `${name(i)}'s certificate expires today`
          : `${name(i)}'s certificate expires in ${plural(days, "day")}`,
        priority: 66,
      });
    }
    if (!found.length) continue;
    const top = found.reduce((best, f) => (f.priority > best.priority ? f : best));
    out.set(businessId, { reason: top.reason, priority: top.priority, openedAt });
  }
  return out;
}

/** Real clients' pages that changed after updates and have waited on a look for more than a day: client id to when the newest of them finished its run. Test clients, test sites and archived sites never count. */
async function pendingLooks(db: D1Database, now: Date): Promise<Map<string, number>> {
  const rows = (await db.prepare(
    `SELECT s.business_id AS business_id, MAX(COALESCE(r.finished_at, r.created_at)) AS at
     FROM care_page_checks c JOIN care_runs r ON r.id = c.run_id JOIN sites s ON s.id = r.site_id JOIN businesses b ON b.id = s.business_id
     WHERE c.review = 'pending' AND COALESCE(r.finished_at, r.created_at) < ? AND s.archived_at IS NULL AND s.test = 0 AND NOT ${testClientSql("b")} GROUP BY s.business_id`,
  ).bind(new Date(now.getTime() - DAY).toISOString()).all<{ business_id: string; at: string }>()).results;
  return new Map(rows.map((r) => [r.business_id, ms(r.at)]));
}

interface ActivityRow { business_id: string; kind: string; detail: string | null; created_at: string; }

/** One activity query per chunk of ids: everything recent, plus every `export` (a draft can be arbitrarily old). */
async function recentActivity(db: D1Database, ids: string[], sinceIso: string): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  for (const part of chunks(ids)) {
    out.push(...(await db.prepare(
      `SELECT business_id, kind, detail, created_at FROM activity
       WHERE business_id IN (${part.map(() => "?").join(",")}) AND (created_at >= ? OR kind = 'export') ORDER BY created_at, id`,
    ).bind(...part, sinceIso).all<ActivityRow>()).results);
  }
  return out;
}

const ms = (iso: string) => Date.parse(iso);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** What to do today, highest priority first. Reads in bulk (one candidate query, one chunked activity query, one suppression list). */
export async function buildToday(db: D1Database, now: Date): Promise<TodayItem[]> {
  const t = now.getTime();
  const candidates = await listTodayCandidates(db, now.toISOString(), MIN_QUICK_SCORE);
  if (!candidates.length) return [];

  // Suppression excludes a lead from searches and automations, not from the owner's own work. A follow-up date or an open deal on a
  // lead marked "Active deal" or "Client" still belongs on Today, so suppressed leads keep follow_up_due and stalled_deal. They are
  // hidden only from draft_unsent and promising_quick_scan, which lead toward outreach or spend. (Departs from "suppressed leads never
  // appear" in the original plan; archived leads are already left out of the candidates for every kind.)
  const suppressed = await suppressedLeadIds(db, candidates);
  // A proposal waiting on a signature for 3 days. The first row per lead (the oldest) speaks for it, as Today holds one item per lead and kind.
  const proposals = new Map<string, { sentAt: number; viewed: boolean }>();
  for (const p of await openProposalsSentBefore(db, new Date(t - PROPOSAL_FOLLOW_UP_DAYS * DAY).toISOString(), new Date(t).toISOString()))
    if (!proposals.has(p.businessId)) proposals.set(p.businessId, { sentAt: ms(p.sentAt), viewed: p.viewed });
  // A client being onboarded: what needs the owner now. One reason per lead, the first that applies (items to review, then a welcome nobody has sent, then silence).
  // Test onboardings are rehearsals and never show. Items to review count whatever the stage: all of them in is when they most need a look.
  const onboarding = new Map<string, string>();
  const openOnboardings = (await listOpenOnboardings(db)).filter((o) => !o.test);
  if (openOnboardings.length) {
    const itemsOf = await listOpenItems(db), nowDate = new Date(t), names = new Map(candidates.map((b) => [b.id, b.name]));
    for (const o of openOnboardings) {
      if (onboarding.has(o.businessId)) continue;
      const items = itemsOf.get(o.id) ?? [], toReview = items.filter((i) => i.status === "received").length, created = ms(o.createdAt);
      const reason = toReview ? `${plural(toReview, "item")} from ${names.get(o.businessId) ?? "the client"} to review`
        : !o.welcomeSentAt && Number.isFinite(created) && t - created > WELCOME_WAITING_DAYS * DAY ? "Welcome email is waiting for you"
        : isWaitingOnClient(o, items, nowDate) ? `No reply for ${plural(silentDays(o, nowDate), "day")}: back of the queue`
        : null;
      if (reason) onboarding.set(o.businessId, reason);
    }
  }
  // A client's projects: what needs the owner now. One reason per lead (review, a Claude step that was given up on, a change order to be paid, tasks due); test projects never show.
  const projects = await projectAttention(db, now);
  // A client's money: a hold, an overdue invoice or a draft waiting for the owner. Real invoices only, and the owner's own work, so it stays for a suppressed lead too.
  const billing = await billingAttention(db, now);
  // A client's site access still missing: the owner's own work (like a project), so it stays for a suppressed lead.
  const access = await accessAttention(db, now);
  // A client's site that is down or whose domain is about to expire: the owner's own work, so it stays for a suppressed lead.
  const incidents = await incidentAttention(db, now);
  // A Care client's edit hours for this month running out: the owner's own work, so it stays for a suppressed lead.
  const editHours = await editHoursAttention(db, now);
  const activity = await recentActivity(db, candidates.map((b) => b.id), new Date(t - ACTIVITY_WINDOW_DAYS * DAY).toISOString());

  const lastContact = new Map<string, number>(), lastExport = new Map<string, number>();
  const queueAction = new Map<string, { hiddenUntil: number; at: number }>(); // `${businessId}|${kind}` -> the latest done/snooze and when it was pressed, rows arrive oldest first
  for (const a of activity) {
    const at = ms(a.created_at);
    if (!Number.isFinite(at)) continue;
    if (a.kind === "export") lastExport.set(a.business_id, Math.max(lastExport.get(a.business_id) ?? -Infinity, at));
    if (!NOT_CONTACT.has(a.kind)) lastContact.set(a.business_id, Math.max(lastContact.get(a.business_id) ?? -Infinity, at));
    if (a.kind === "today_done" && a.detail && isTodayKind(a.detail)) queueAction.set(`${a.business_id}|${a.detail}`, { hiddenUntil: at + DONE_HIDES_DAYS * DAY, at });
    if (a.kind === "snoozed") {
      const s = parseSnooze(a.detail);
      if (s) queueAction.set(`${a.business_id}|${s.kind}`, { hiddenUntil: s.until, at });
    }
  }
  // `since`: a done or snooze only counts when it was pressed after that time. A site incident passes when its newest open incident opened, so a new outage after the owner marked
  // the old one done shows at once instead of staying hidden for the rest of the week.
  const hidden = (businessId: string, kind: TodayKind, since = -Infinity) => {
    const a = queueAction.get(`${businessId}|${kind}`);
    return !!a && a.at > since && a.hiddenUntil > t;
  };

  const items: TodayItem[] = [];
  const quick: { item: TodayItem; score: number }[] = [];
  const open = (s: string) => s !== "won" && s !== "lost" && s !== "skip";
  const push = (kind: TodayKind, b: { id: string; name: string }, reason: string, due: string | null, priority: number) =>
    ({ id: `${kind}:${b.id}`, kind, businessId: b.id, businessName: b.name, reason, due, priority }) satisfies TodayItem;

  for (const b of candidates) {
    if (b.follow_up_at && ms(b.follow_up_at) <= t && open(b.lead_status) && !hidden(b.id, "follow_up_due")) {
      const late = Math.max(0, Math.floor((t - ms(b.follow_up_at)) / DAY));
      items.push(push("follow_up_due", b, late === 0 ? "Follow-up is due today" : `Follow-up was due ${plural(late, "day")} ago`,
        b.follow_up_at, 100 + Math.min(late, MAX_OVERDUE_BONUS)));
    }
    if (!suppressed.has(b.id) && (b.lead_status === "new" || b.lead_status === "reviewed") && b.latest_draft_at && !hidden(b.id, "draft_unsent")) {
      const at = ms(b.latest_draft_at), age = t - at;
      if (age > DRAFT_UNSENT_DAYS * DAY && (lastExport.get(b.id) ?? -Infinity) < at)
        items.push(push("draft_unsent", b, `Email draft written ${plural(Math.floor(age / DAY), "day")} ago and never exported`, null, 60));
    }
    if ((b.lead_status === "contacted" || b.lead_status === "replied") && b.deal_value !== null && !hidden(b.id, "stalled_deal")
      && (lastContact.get(b.id) ?? -Infinity) <= t - STALLED_DAYS * DAY)
      items.push(push("stalled_deal", b, `${money(b.deal_value)} deal (${b.lead_status}) with no activity in ${STALLED_DAYS} days`, null, 70));
    // Chasing a signature is the owner's own deal work (like a stalled deal), so it stays for a suppressed lead. The proposal query already left out
    // signed, void and expired documents and deals that are no longer at proposal_sent (lost or won).
    const proposal = proposals.get(b.id);
    if (proposal && Number.isFinite(proposal.sentAt) && !hidden(b.id, "proposal_follow_up")) {
      const days = plural(Math.floor((t - proposal.sentAt) / DAY), "day");
      items.push(push("proposal_follow_up", b, `Proposal sent ${days} ago, ${proposal.viewed ? "opened, not signed" : "not opened"}`, null, 65));
    }
    // A client's project is the owner's own work too (like a stalled deal), so it stays for a suppressed lead.
    const project = projects.get(b.id);
    if (project && !hidden(b.id, "project_attention")) items.push(push("project_attention", b, project, null, 68));
    const owed = billing.get(b.id);
    if (owed && !hidden(b.id, "billing_attention")) items.push(push("billing_attention", b, owed.reason, null, owed.priority));
    const noAccess = access.get(b.id);
    if (noAccess && !hidden(b.id, "access_missing")) items.push(push("access_missing", b, noAccess.reason, null, noAccess.priority));
    const incident = incidents.get(b.id);
    if (incident && !hidden(b.id, "site_incident", incident.openedAt)) items.push(push("site_incident", b, incident.reason, null, incident.priority));
    const edits = editHours.get(b.id);
    if (edits && !hidden(b.id, "care_edit_hours"))
      items.push(push("care_edit_hours", b, edits.percent === null ? `${b.name} has logged edit time this month with no edit hours included` : `${b.name} has used ${edits.percent}% of this month's edit hours`, null, edits.priority));
    // A paying client's onboarding is the owner's own work (like a stalled deal), so it stays for a suppressed lead.
    const attention = onboarding.get(b.id);
    if (attention && !hidden(b.id, "onboarding_attention")) items.push(push("onboarding_attention", b, attention, null, 70));
    // The owner's own reminder about a lead they saved, not outreach, so (like a follow-up) it stays for a suppressed lead.
    if (b.starred_at && open(b.lead_status) && !hidden(b.id, "starred_idle")) {
      const starredAt = ms(b.starred_at), touched = lastContact.get(b.id) ?? -Infinity;
      if (Number.isFinite(starredAt) && Math.max(starredAt, touched) <= t - STARRED_IDLE_DAYS * DAY) {
        const saved = `Starred ${plural(Math.floor((t - starredAt) / DAY), "day")} ago`;
        items.push(push("starred_idle", b, touched > starredAt ? `${saved}, no activity in ${plural(Math.floor((t - touched) / DAY), "day")}` : `${saved}, nothing since`, null, 50));
      }
    }
    if (!suppressed.has(b.id) && b.scan_stage === "quick" && open(b.lead_status) && b.latest_score !== null && b.latest_score >= MIN_QUICK_SCORE && !hidden(b.id, "promising_quick_scan"))
      quick.push({ score: b.latest_score, item: push("promising_quick_scan", b, `Quick scan scored ${b.latest_score}. Worth a full scan`, null, 40) });
  }
  // Hidden and suppressed quick-scan leads were skipped above, so the cap counts only what the user would see.
  quick.sort((a, c) => c.score - a.score);
  items.push(...quick.slice(0, MAX_QUICK_ITEMS).map((q) => q.item));

  // Array.sort is stable, so ties keep the order above (the quick-scan ones stay best-score first).
  return items.sort((a, c) => c.priority - a.priority || (a.due && c.due ? ms(a.due) - ms(c.due) : a.due ? -1 : c.due ? 1 : 0));
}
