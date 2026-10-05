import { chunks } from "./db/chunks";
import { listTodayCandidates } from "./db/businesses";
import { suppressedLeadIds } from "./db/suppression";

export const TODAY_KINDS = ["follow_up_due", "draft_unsent", "stalled_deal", "promising_quick_scan"] as const;
export type TodayKind = (typeof TODAY_KINDS)[number];
export const isTodayKind = (s: string): s is TodayKind => (TODAY_KINDS as readonly string[]).includes(s);

export interface TodayItem {
  /** `${kind}:${businessId}` */
  id: string; kind: TodayKind; businessId: string; businessName: string; reason: string;
  /** ISO time the item became due (follow-ups only), else null. */
  due: string | null; priority: number;
}

const DAY = 86_400_000;
export const DONE_HIDES_DAYS = 7, STALLED_DAYS = 14, DRAFT_UNSENT_DAYS = 2, MIN_QUICK_SCORE = 50, MAX_QUICK_ITEMS = 5, MAX_OVERDUE_BONUS = 30;
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
const NOT_CONTACT = new Set(["today_done", "snoozed", "bulk"]);

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
  const activity = await recentActivity(db, candidates.map((b) => b.id), new Date(t - ACTIVITY_WINDOW_DAYS * DAY).toISOString());

  const lastContact = new Map<string, number>(), lastExport = new Map<string, number>();
  const queueAction = new Map<string, { hiddenUntil: number }>(); // `${businessId}|${kind}` -> the latest done/snooze, rows arrive oldest first
  for (const a of activity) {
    const at = ms(a.created_at);
    if (!Number.isFinite(at)) continue;
    if (a.kind === "export") lastExport.set(a.business_id, Math.max(lastExport.get(a.business_id) ?? -Infinity, at));
    if (!NOT_CONTACT.has(a.kind)) lastContact.set(a.business_id, Math.max(lastContact.get(a.business_id) ?? -Infinity, at));
    if (a.kind === "today_done" && a.detail && isTodayKind(a.detail)) queueAction.set(`${a.business_id}|${a.detail}`, { hiddenUntil: at + DONE_HIDES_DAYS * DAY });
    if (a.kind === "snoozed") {
      const s = parseSnooze(a.detail);
      if (s) queueAction.set(`${a.business_id}|${s.kind}`, { hiddenUntil: s.until });
    }
  }
  const hidden = (businessId: string, kind: TodayKind) => (queueAction.get(`${businessId}|${kind}`)?.hiddenUntil ?? -Infinity) > t;

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
    if (!suppressed.has(b.id) && b.scan_stage === "quick" && open(b.lead_status) && b.latest_score !== null && b.latest_score >= MIN_QUICK_SCORE && !hidden(b.id, "promising_quick_scan"))
      quick.push({ score: b.latest_score, item: push("promising_quick_scan", b, `Quick scan scored ${b.latest_score}. Worth a full scan`, null, 40) });
  }
  // Hidden and suppressed quick-scan leads were skipped above, so the cap counts only what the user would see.
  quick.sort((a, c) => c.score - a.score);
  items.push(...quick.slice(0, MAX_QUICK_ITEMS).map((q) => q.item));

  // Array.sort is stable, so ties keep the order above (the quick-scan ones stay best-score first).
  return items.sort((a, c) => c.priority - a.priority || (a.due && c.due ? ms(a.due) - ms(c.due) : a.due ? -1 : c.due ? 1 : 0));
}
