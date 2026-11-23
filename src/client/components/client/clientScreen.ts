import type { Tone } from "../ds";
import type { IconName } from "../Icon";
import { describeActivity } from "../../activityView";
import { moneyLabel, renewalLabel } from "../../clientView";
import type { Activity } from "../../types";
import type { ClientRecord, ClientRow } from "../../../worker/clients/record";

/** Pure helpers for the rebuilt Clients list and client record (Figma 63:4704, 63:5152). No DOM, no fetch, no clock of their own. */

export type PlanKey = "care" | "care_plus" | "monthly" | "none";
export const PLAN_LABEL: Record<PlanKey, string> = { care: "Care", care_plus: "Care Plus", monthly: "Monthly plan", none: "No plan" };
const PLAN_TONE: Record<PlanKey, Tone> = { care: "neutral", care_plus: "info", monthly: "signal", none: "outline" };

/** Which plan a list row is on, from what the list knows: the Care label ("Care Plus $249/mo"), else any monthly billing, else none. */
export function planOf(r: Pick<ClientRow, "careLabel" | "mrrCents">): PlanKey {
  if (r.careLabel?.startsWith("Care Plus")) return "care_plus";
  if (r.careLabel) return "care";
  return r.mrrCents > 0 ? "monthly" : "none";
}
export const planTone = (k: PlanKey): Tone => PLAN_TONE[k];

export type PlanFilter = "all" | PlanKey;
export const isPlanFilter = (s: string | null): s is PlanFilter => s === "all" || (s !== null && s in PLAN_LABEL);

/** The plan segments with their counts; a plan nobody is on is left out (All always shows). */
export function planOptions(rows: Pick<ClientRow, "careLabel" | "mrrCents">[]): { key: PlanFilter; label: string; count: number }[] {
  const keys: PlanKey[] = ["care", "care_plus", "monthly", "none"];
  return [{ key: "all" as PlanFilter, label: "All", count: rows.length }, ...keys.map((k) => ({ key: k as PlanFilter, label: PLAN_LABEL[k], count: rows.filter((r) => planOf(r) === k).length })).filter((o) => o.count > 0)];
}
export const filterByPlan = <T extends Pick<ClientRow, "careLabel" | "mrrCents">>(rows: T[], by: PlanFilter): T[] => (by === "all" ? rows : rows.filter((r) => planOf(r) === by));

/** The sidebar's views: clients with access still missing, and clients who owe money. */
export type ClientListView = "access" | "owing";
export const isListView = (s: string | null): s is ClientListView => s === "access" || s === "owing";
export const VIEW_TITLE: Record<ClientListView, string> = { access: "Access missing", owing: "Owes money" };
export const filterByView = <T extends Pick<ClientRow, "accessMissing" | "openInvoiceCents" | "held">>(rows: T[], view: ClientListView | null): T[] =>
  view === "access" ? rows.filter((r) => r.accessMissing > 0) : view === "owing" ? rows.filter((r) => r.openInvoiceCents > 0 || r.held) : rows;

/** The tone of a health score: 80 and up good (green), 60 to 79 watch (amber), under 60 at risk (red). */
export const healthTone = (score: number): "positive" | "warning" | "critical" => (score >= 80 ? "positive" : score >= 60 ? "warning" : "critical");
export const healthWord = (score: number): string => (score >= 80 ? "healthy" : score >= 60 ? "watch" : "at risk");

/** The one next thing for a client in the list, from data the list has: billing on hold, money owed, access missing, a renewal within 90 days. Null when there is nothing. */
export function nextThing(r: Pick<ClientRow, "held" | "openInvoiceCents" | "accessMissing" | "nextRenewalOn">, today: string): { text: string; tone: "critical" | "warning" | "neutral" } | null {
  if (r.held) return { text: `Billing on hold${r.openInvoiceCents > 0 ? `: ${moneyLabel(r.openInvoiceCents)} owed` : ""}`, tone: "critical" };
  if (r.openInvoiceCents > 0) return { text: `${moneyLabel(r.openInvoiceCents)} owed`, tone: "critical" };
  if (r.accessMissing > 0) return { text: `${r.accessMissing} access ${r.accessMissing === 1 ? "item" : "items"} missing`, tone: "warning" };
  const renewal = renewalLabel(r.nextRenewalOn, today);
  if (r.nextRenewalOn && renewal !== "No term") return { text: renewal, tone: renewal === "Term ended" ? "warning" : "neutral" };
  return null;
}

/** The summary under the list's title: "7 active · $1,730 a month · average health 79". Average over the clients that have a score. */
export function listSummary(rows: Pick<ClientRow, "mrrCents" | "healthScore">[]): { mrrCents: number; avgHealth: number | null; line: string } {
  const mrrCents = rows.reduce((n, r) => n + r.mrrCents, 0);
  const scored = rows.map((r) => r.healthScore).filter((s): s is number => s !== null);
  const avgHealth = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const parts = [`${rows.length} ${rows.length === 1 ? "client" : "clients"}`, `${moneyLabel(mrrCents)} a month`];
  if (avgHealth !== null) parts.push(`average health ${avgHealth}`);
  return { mrrCents, avgHealth, line: parts.join(" · ") };
}

/** The kinds the record's timeline can be filtered by. */
export type TimelineKind = "all" | "emails" | "meetings" | "money" | "site" | "notes";
export const TIMELINE_KINDS: { key: TimelineKind; label: string }[] = [
  { key: "all", label: "All" }, { key: "emails", label: "Emails" }, { key: "meetings", label: "Meetings" }, { key: "money", label: "Money" }, { key: "site", label: "Site" }, { key: "notes", label: "Notes" },
];
const KIND_OF: Record<string, Exclude<TimelineKind, "all">> = {
  email_sent: "emails", email_reply: "emails", email_bounce: "emails", draft: "emails", care_report_sent: "emails", seo_report_sent: "emails", ladder_sent: "emails", strategy_sent: "emails", onboarding_welcome: "emails",
  meeting_recorded: "meetings", booked: "meetings", booking_cancelled: "meetings", call_prep: "meetings", call_recap: "meetings", followup_booked: "meetings",
  invoice_sent: "money", invoice_paid: "money", deposit_paid: "money", billing_hold_placed: "money", proposal_sent: "money", proposal_viewed: "money", proposal_signed: "money", proposal_void: "money",
  change_order_sent: "money", change_order_signed: "money", change_order_paid: "money", change_order_void: "money", change_order_declined: "money",
  site_added: "site", site_changed: "site", access_changed: "site", site_down: "site", site_back: "site", domain_expiring: "site", care_updated: "site", care_rolled_back: "site", traffic_linked: "site",
  note: "notes",
};
export const timelineKindOf = (kind: string): Exclude<TimelineKind, "all"> | null => KIND_OF[kind] ?? null;

export interface TimelineItem { key: string; icon: IconName; tone: Tone; title: string; sub: string | null; when: string; at: string }

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The client's activity as the record's timeline, newest first, in TODAY / THIS MONTH / EARLIER groups (empty groups dropped by the Timeline itself). */
export function timelineGroups(items: Activity[], filter: TimelineKind, now = new Date()): { label: string; events: TimelineItem[] }[] {
  const groups = { today: [] as TimelineItem[], month: [] as TimelineItem[], earlier: [] as TimelineItem[] };
  const shown = [...items].filter((a) => filter === "all" || timelineKindOf(a.kind) === filter).sort((x, y) => y.created_at.localeCompare(x.created_at));
  for (const a of shown) {
    const d = new Date(a.created_at);
    const v = describeActivity(a);
    const today = sameDay(d, now);
    const when = today
      ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
    const item: TimelineItem = { key: a.id, icon: v.icon, tone: v.tone, title: v.title, sub: v.detail, when, at: a.created_at };
    if (today) groups.today.push(item);
    else if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) groups.month.push(item);
    else groups.earlier.push(item);
  }
  return [{ label: "Today", events: groups.today }, { label: "This month", events: groups.month }, { label: "Earlier", events: groups.earlier }];
}

/** The Health card's lines: each deduction as a cross, then the checks this record can vouch for as ticks (no overdue invoice, access all in, sites up, billing running). */
export function healthLines(c: Pick<ClientRecord, "health" | "invoices" | "sites" | "held">): { ok: boolean; text: string }[] {
  const bad = c.health.reasons.map((text) => ({ ok: false, text }));
  const good: { ok: boolean; text: string }[] = [];
  const has = (s: string) => c.health.reasons.some((r) => r.toLowerCase().includes(s));
  if (c.invoices.overdueCount === 0 && !has("invoice")) good.push({ ok: true, text: c.invoices.paidCents > 0 ? "No invoice overdue" : "Nothing owed" });
  if (c.sites.length > 0 && !has("access") && c.sites.every((s) => s.access.every((a) => a.status === "received" || a.status === "verified" || a.status === "not_applicable"))) good.push({ ok: true, text: "All site access is in" });
  const watched = c.sites.filter((s) => s.monitoring.monitored && s.monitoring.up !== null);
  if (watched.length > 0 && watched.every((s) => s.monitoring.up) && !has("down")) good.push({ ok: true, text: watched.length === 1 ? "Site is up" : "All sites are up" });
  if (!c.held && !has("hold")) good.push({ ok: true, text: "Billing is running" });
  return [...bad, ...good];
}

/** The single most urgent thing on a client's record, or null: on hold, overdue invoice, a site down, access missing. */
export function recordBanner(c: Pick<ClientRecord, "held" | "invoices" | "health" | "sites">): { tone: "critical" | "warning"; title: string; text: string; tab: "overview" | "sites" | "care" | "account" } | null {
  if (c.held) return { tone: "critical", title: "Billing is on hold", text: "Work is paused until the overdue invoice is paid. Open billing to chase it or lift the hold.", tab: "account" };
  if (c.invoices.overdueCount > 0) return { tone: "warning", title: `${c.invoices.overdueCount} ${c.invoices.overdueCount === 1 ? "invoice is" : "invoices are"} overdue`, text: `${moneyLabel(c.invoices.openCents)} is still open. Open billing to send a reminder.`, tab: "account" };
  if (c.health.reasons.includes("Site is down")) return { tone: "critical", title: "A site is down", text: "Check the Care tab for the incident and the site's state.", tab: "care" };
  const missing = c.sites.reduce((n, s) => n + s.access.filter((a) => a.status === "needed" || a.status === "requested").length, 0);
  if (missing > 0) return { tone: "warning", title: `${missing} access ${missing === 1 ? "item is" : "items are"} still missing`, text: "Ask the client for them, then mark each one received on Sites & access.", tab: "sites" };
  return null;
}

/** One line of the record's setup checklist. `to` opens another page; otherwise `tab` is the record's own tab that does it. */
export interface SetupStep { key: string; icon: IconName; title: string; sub: string; done: boolean; action: string; tab: "sites" | "care" | "followups"; to?: string }

/**
 * What a client still needs before the work runs by itself, from the record alone: a person to talk to, a site with its platform and way in, the access, the uptime watch and,
 * while there is one, the Care onboarding. Done lines stay in the list (ticked) so the count reads true.
 */
export function setupSteps(c: Pick<ClientRecord, "business" | "people" | "sites" | "projects">): SetupStep[] {
  const id = encodeURIComponent(c.business.id);
  const out: SetupStep[] = [];
  const poc = c.people.find((p) => p.is_poc) ?? c.people[0];
  out.push({ key: "contact", icon: "user", title: "Point of contact", sub: poc ? `${poc.name}${poc.role ? `, ${poc.role}` : ""}` : "Nobody to email or call yet", done: !!poc, action: "Add", tab: "followups", to: `/leads/${id}` });
  if (c.sites.length === 0) {
    out.push({ key: "site", icon: "globe", title: "The client’s site", sub: "No site saved yet", done: false, action: "Add", tab: "sites" });
  } else {
    const unknown = c.sites.filter((s) => s.site.cms === "unknown" || s.site.accessMethod === "unknown").length;
    out.push({ key: "details", icon: "code", title: "Site details", sub: unknown === 0 ? "Platform and way in are known" : "Platform not set yet", done: unknown === 0, action: "Fill in", tab: "sites" });
    const items = c.sites.flatMap((s) => s.access).filter((a) => a.status !== "not_applicable");
    const inHand = items.filter((a) => a.status === "received" || a.status === "verified").length;
    out.push({ key: "access", icon: "key", title: "Site access", sub: `${inHand} of ${items.length} logins in`, done: items.length > 0 && inHand === items.length, action: inHand === 0 ? "Ask" : "Open", tab: "sites" });
    const watched = c.sites.some((s) => s.monitoring.monitored);
    out.push({ key: "watch", icon: "gauge", title: "Uptime watch", sub: watched ? "Checked every few minutes" : "Nobody is watching the site yet", done: watched, action: "Turn on", tab: "care" });
  }
  const onboarding = c.projects.find((p) => p.kind === "care_onboarding" && (p.status === "active" || p.status === "paused"));
  if (onboarding) {
    const total = onboarding.doneTasks + onboarding.openTasks;
    out.push({ key: "onboarding", icon: "briefcase", title: "Care onboarding", sub: `${onboarding.doneTasks} of ${total} steps done`, done: false, action: "Open", tab: "sites", to: `/projects/${encodeURIComponent(onboarding.id)}` });
  }
  return out;
}
