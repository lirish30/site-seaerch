import { estimateRemainingSeconds } from "./eta";
import { describeActivity } from "./activityView";
import type { IconName } from "./components/iconMarkup";
import type { LeadStatus, Radar, Search } from "./types";

/** GET /api/today/summary (src/worker/todaySummary.ts). */
export interface RecentActivity { id: string; businessId: string; businessName: string; kind: string; detail: string | null; at: string }
export interface TodaySummary {
  hot: { total: number; newThisWeek: number };
  drafts: { ready: number; waiting: number };
  replied: { total: number; thisWeek: number };
  won: { thisMonth: number; valueThisMonth: number; openValue: number };
  pipeline: Record<LeadStatus, number>;
  totalLeads: number;
  recent: RecentActivity[];
}
/** One row of GET /api/settings `usage`. */
export interface UsageRow { service: string; units: number; est_cost_usd: number }

/** "Good morning, Logan": the greeting for the hour, with the first word of the name from Settings when there is one. */
export function greeting(name: string, now = new Date()): string {
  const h = now.getHours(), first = name.trim().split(/\s+/)[0];
  const word = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return first ? `${word}, ${first}` : word;
}

/** "Wednesday, October 15 · 9 things need you today". */
export function dayLine(count: number | null, now = new Date()): string {
  const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (count === null) return date;
  return `${date} · ${count === 0 ? "nothing needs you today" : `${count} ${count === 1 ? "thing needs" : "things need"} you today`}`;
}

/** $9,400 (whole dollars, for headline numbers). */
export const moneyWhole = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
/** $18.2k, $950, $1.2M (short, for the small print). */
export function moneyShort(n: number): string {
  if (n < 1000) return `$${Math.round(n)}`;
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  return n < 1_000_000 ? `$${trim(n / 1000)}k` : `$${trim(n / 1_000_000)}M`;
}
/** $41.20 (cents, for spend). */
export const moneyCents = (n: number) => `$${n.toFixed(2)}`;

export type Tone = "positive" | "warning" | "muted";
export interface Kpi { key: string; label: string; icon: IconName; value: string; sub: string; tone: Tone }

/** The four KPI cards from the summary. The small line turns grey instead of showing "+0" when there is nothing to report. */
export function kpiCards(s: TodaySummary): Kpi[] {
  const { hot, drafts, replied, won } = s;
  return [
    { key: "hot", label: "Hot leads", icon: "zap", value: String(hot.total), sub: hot.newThisWeek > 0 ? `+${hot.newThisWeek} this week` : "None new this week", tone: hot.newThisWeek > 0 ? "positive" : "muted" },
    { key: "drafts", label: "Drafts ready to send", icon: "mail", value: String(drafts.ready), sub: drafts.waiting > 0 ? `${drafts.waiting} waiting 2+ days` : drafts.ready > 0 ? "None waiting 2+ days" : "Nothing waiting", tone: drafts.waiting > 0 ? "warning" : "muted" },
    { key: "conversation", label: "In conversation", icon: "users", value: String(replied.total), sub: replied.thisWeek > 0 ? `${replied.thisWeek} replied this week` : "No replies this week", tone: replied.thisWeek > 0 ? "positive" : "muted" },
    { key: "won", label: "Won this month", icon: "trending", value: moneyWhole(won.valueThisMonth), sub: `${won.thisMonth} ${won.thisMonth === 1 ? "deal" : "deals"} · ${moneyShort(won.openValue)} open`, tone: "muted" },
  ];
}

export const PIPELINE_STAGES = [
  { key: "new", label: "New", color: "var(--text-3)" }, { key: "reviewed", label: "Reviewed", color: "var(--border-strong)" },
  { key: "contacted", label: "Contacted", color: "var(--info)" }, { key: "replied", label: "Replied", color: "var(--signal)" },
  { key: "won", label: "Won", color: "var(--positive)" },
] as const;

/** The five pipeline stages with their counts, and their total (the Pipeline count in the sidebar). */
export function pipelineRows(p: Record<LeadStatus, number>) {
  const rows = PIPELINE_STAGES.map((s) => ({ ...s, count: p[s.key] ?? 0 }));
  return { rows, total: rows.reduce((n, r) => n + r.count, 0) };
}

const SPEND_ROWS: { label: string; services: string[] }[] = [
  { label: "Google Maps listings", services: ["brightdata", "places"] },
  { label: "AI reviews & drafts", services: ["claude", "claude_cro"] },
  { label: "Browser checks", services: ["browser", "pagespeed"] },
];
/** This month's spend: the total (usage plus active fixed costs, the same sum the cap enforces), how much of the limit it is (0-100), and the three usage lines under it. */
export function spendView(usage: readonly UsageRow[], limit: number, fixedUsd = 0) {
  const cost = (services: string[]) => usage.filter((u) => services.includes(u.service)).reduce((n, u) => n + (u.est_cost_usd || 0), 0);
  const known = SPEND_ROWS.flatMap((r) => r.services);
  // Anything not named above (a future service) still counts toward the total, so it is added to the last line rather than lost.
  const rows = SPEND_ROWS.map((r) => ({ label: r.label, usd: cost(r.services) }));
  rows[rows.length - 1].usd += usage.filter((u) => !known.includes(u.service)).reduce((n, u) => n + (u.est_cost_usd || 0), 0);
  const total = rows.reduce((n, r) => n + r.usd, 0) + fixedUsd;
  const pct = limit > 0 ? Math.min(100, (100 * total) / limit) : total > 0 ? 100 : 0;
  return { rows, total, pct, over: total >= limit && total > 0 };
}
/** "$150" for a whole limit, "$37.50" otherwise. */
export const limitLabel = (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : moneyCents(n));

/** "3 min left", "under a minute left"; null once the search has no estimate. */
export function leftLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  return seconds < 60 ? "under a minute left" : `${Math.round(seconds / 60)} min left`;
}

/** The "Running now" card in the sidebar: title, status line and how full the bar is. */
export function runningCard(s: Search, nowMs = Date.now()) {
  const type = s.business_type ? `${s.business_type[0].toUpperCase()}${s.business_type.slice(1)}` : "Search";
  if (!s.found_count) return { title: `${type} in ${s.location}`, status: "Finding listings on Google Maps…", pct: 15, finding: true };
  const left = leftLabel(estimateRemainingSeconds(s, nowMs));
  return { title: `${type} in ${s.location}`, status: `${s.processed_count} of ${s.found_count} audited${left ? ` · ${left}` : ""}`,
    pct: Math.min(100, Math.round((100 * s.processed_count) / s.found_count)), finding: false };
}

/** "in 2d", "today": when a radar fires next. A paused radar says so. */
export function radarNext(r: Pick<Radar, "enabled" | "next_run_at">, now = Date.now()): string {
  if (!r.enabled) return "paused";
  const d = Math.ceil((Date.parse(r.next_run_at) - now) / 86_400_000);
  return !Number.isFinite(d) ? "" : d <= 0 ? "today" : `in ${d}d`;
}

/** "5m ago", "3h ago", "2d ago", then the date: how long ago an activity row happened. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How a recent-activity row reads, reusing the lead page's wording ("Stage changed: Contacted → Replied"). */
export const recentView = (a: RecentActivity) => describeActivity({ kind: a.kind,detail: a.detail });

// ---- Home v2 (Figma 57:3846) ----

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an approval is, in one word, from its kind: "email.send" → draft. Used to sum up the "Waiting on you" number. */
export function approvalNoun(kind: string): "draft" | "invoice" | "proposal" | "video" | "report" | "other" {
  const head = kind.split(".")[0];
  return head === "email" ? "draft" : head === "invoice" || head === "subscription" ? "invoice" : head === "proposal" || head === "change_order" ? "proposal"
    : head === "video" ? "video" : head === "care" || head === "seo" ? "report" : "other";
}

/** The "Waiting on you" stat: approvals plus Up next items, and the one line that says what they are ("4 drafts · 2 invoices · 7 to do"). */
export function waitingStat(approvalKinds: readonly string[], itemCount: number): { total: number; sub: string } {
  const counts = new Map<string, number>();
  for (const k of approvalKinds) { const n = approvalNoun(k); counts.set(n, (counts.get(n) ?? 0) + 1); }
  const order: [string, string][] = [["draft", "draft"], ["invoice", "invoice"], ["proposal", "proposal"], ["video", "video"], ["report", "report"], ["other", "other approval"]];
  const parts = order.filter(([k]) => counts.get(k)).map(([k, w]) => plural(counts.get(k)!, w));
  if (itemCount > 0) parts.push(`${itemCount} to do`);
  const total = approvalKinds.length + itemCount;
  return { total, sub: total === 0 ? "Nothing waiting. Nice." : parts.join(" · ") };
}

/** The second line of an approval row: for an email, who it goes to and the subject; otherwise the first line of the preview. */
export function approvalSub(preview: string): string {
  const lines = preview.split("\n").map((l) => l.trim()).filter(Boolean);
  const to = lines.find((l) => l.startsWith("To:"))?.slice(3).trim();
  const subject = lines.find((l) => l.startsWith("Subject:"))?.slice(8).trim();
  if (to || subject) return [to && `To ${to}`, subject].filter(Boolean).join(" · ");
  return lines[0] ?? "";
}

/** The chip on an approval row: what kind of thing it is, coloured by what approving it does. */
export function approvalChip(kind: string): { label: string; tone: "info" | "warning" | "signal" | "positive" | "neutral" } {
  switch (approvalNoun(kind)) {
    case "draft": return { label: "Email", tone: "info" };
    case "invoice": return { label: "Invoice", tone: "warning" };
    case "proposal": return { label: kind.startsWith("change_order") ? "Change order" : "Proposal", tone: "info" };
    case "video": return { label: "Video", tone: "signal" };
    case "report": return { label: "Report", tone: "positive" };
    default: return { label: "Approval", tone: "neutral" };
  }
}

/** The icon tile for an approval row. */
export function approvalIcon(kind: string): { icon: IconName; tone: "info" | "warning" | "signal" | "positive" | "neutral" } {
  const n = approvalNoun(kind);
  return n === "draft" ? { icon: "mail", tone: "info" } : n === "invoice" ? { icon: "card", tone: "warning" } : n === "proposal" ? { icon: "file-text", tone: "info" }
    : n === "video" ? { icon: "eye", tone: "signal" } : n === "report" ? { icon: "check", tone: "positive" } : { icon: "sparkles", tone: "neutral" };
}

/** One subscription row as GET /billing/subscriptions returns it (only the fields Home reads). */
export interface SubLite { packageKey: string; monthlyCents: number; status: string; test?: boolean }
const LIVE_SUBS = ["active", "past_due"];

/** The Freedom number card: monthly recurring revenue against the goal, how far along, and the mix of plans that makes it up. */
export function freedomView(f: { targetCents: number; mrrCents: number }, subs: readonly SubLite[] | null, names: ReadonlyMap<string, string>) {
  const live = (subs ?? []).filter((s) => !s.test && LIVE_SUBS.includes(s.status));
  const byPlan = new Map<string, { count: number; cents: number }>();
  for (const s of live) { const p = byPlan.get(s.packageKey) ?? { count: 0, cents: 0 }; p.count += 1; p.cents += s.monthlyCents; byPlan.set(s.packageKey, p); }
  const rows = [...byPlan.entries()].sort((a, b) => b[1].cents - a[1].cents)
    .map(([key, p]) => ({ key, label: `${names.get(key) ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} · ${plural(p.count, "client")}`, cents: p.cents }));
  const pct = f.targetCents > 0 ? Math.min(100, (100 * f.mrrCents) / f.targetCents) : 0;
  const gap = Math.max(0, f.targetCents - f.mrrCents);
  const avg = live.length > 0 ? f.mrrCents / live.length : 0;
  const more = avg > 0 ? Math.ceil(gap / avg) : null;
  const line = f.targetCents <= 0 ? "Set a monthly goal on the Money page to track it here."
    : gap === 0 ? "Goal reached. Everything from here is extra."
    : `${Math.round(pct)}% there${more !== null ? ` · about ${plural(more, "more client")} at the current mix` : ""}`;
  return { mrr: moneyWhole(f.mrrCents / 100), goal: moneyWhole(f.targetCents / 100), pct, line, rows: rows.map((r) => ({ ...r, value: moneyWhole(r.cents / 100) })) };
}

/** The "Calls this week" stat: how many are coming up and the next one ("Next: Thu 10:00 · Rose City Electric"). */
export function callsStat<T extends { startAt: string; businessName: string }>(upcoming: readonly { booking: T; when: string }[]): { count: number; sub: string } {
  if (upcoming.length === 0) return { count: 0, sub: "Nothing booked in the next 7 days" };
  const next = upcoming[0];
  return { count: upcoming.length, sub: `Next: ${next.when} · ${next.booking.businessName}` };
}

/** Recent activity in Figma's groups: Today, This week, Earlier (by the viewer's local day). */
export function activityGroups<T extends { at: string }>(rows: readonly T[], now = new Date()): { label: string; rows: T[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = start - 6 * 86_400_000;
  const groups = [{ label: "Today", rows: [] as T[] }, { label: "This week", rows: [] as T[] }, { label: "Earlier", rows: [] as T[] }];
  for (const r of rows) { const t = Date.parse(r.at); groups[t >= start ? 0 : t >= week ? 1 : 2].rows.push(r); }
  return groups.filter((g) => g.rows.length > 0);
}

/** The one thing to point at on Home, when there is one: late follow-ups first, then drafts that are ready but unsent. */
export function homeBanner(s: { lateFollowUps: number; approvals: number; draftsReady: number; draftsWaiting: number }):
  { tone: "warning" | "info"; title: string; body: string; action: "follow_ups" | "outreach" } | null {
  if (s.lateFollowUps > 0) return { tone: "warning", title: `${plural(s.lateFollowUps, "follow-up is", "follow-ups are")} late`, body: "The longer a lead waits, the colder it gets. Send these first.", action: "follow_ups" };
  if (s.approvals === 0 && s.draftsReady > 0) return { tone: "info", title: `${plural(s.draftsReady, "draft is", "drafts are")} ready to send`,
    body: s.draftsWaiting > 0 ? `${s.draftsWaiting} of them have waited 2+ days. Review and send them from Outreach.` : "Review and send them from Outreach.", action: "outreach" };
  return null;
}
