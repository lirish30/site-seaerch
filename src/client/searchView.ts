import { STOPPED_ERROR } from "../worker/search-stop";
import { PER_LEAD_COST } from "../worker/cost";
import { estimateRemainingSeconds, searchStage } from "./eta";
import { HOT_AT, WARM_AT } from "./scoreView";
import type { LeadRow, Radar, Search } from "./types";

/** A search as the history and progress screens show it: "failed" splits into a real failure and one the user stopped. */
export type RunState = "running" | "done" | "failed" | "stopped";
export const runState = (s: Search): RunState => (s.status === "failed" ? (s.error === STOPPED_ERROR ? "stopped" : "failed") : s.status);
export const STATE_LABEL: Record<RunState, string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };
export const STATE_TONE: Record<RunState, "info" | "positive" | "critical" | "neutral"> = { running: "info", done: "positive", failed: "critical", stopped: "neutral" };

/** An import files its leads under a finished container search, business type "import" (see createImportSearch). */
export const isImport = (s: Pick<Search, "business_type">) => s.business_type === "import";
const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
/** "Plumber in Boise, ID"; an import is just its own name. */
export const searchTitle = (s: Pick<Search, "business_type" | "location">) => (isImport(s) ? s.location : `${cap(s.business_type)} in ${s.location}`);
export const scanLabel = (s: Pick<Search, "business_type" | "quick_scan">): "Quick" | "Full" | "—" => (isImport(s) ? "—" : s.quick_scan === 1 ? "Quick" : "Full");

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, (m) => ` ${m.trim().toLowerCase()}`);
const dayText = (d: Date, now: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });

/** The history row's second line: "Today, 9:12 am", or "Oct 13" with " · Radar run" for a scheduled radar's run. */
export function startedLabel(s: Pick<Search, "created_at" | "new_only">, now = new Date()): string {
  const d = new Date(s.created_at);
  const when = sameDay(d, now) ? `Today, ${clock(d)}` : dayText(d, now);
  return s.new_only === 1 ? `${when} · Radar run` : when;
}

/** The progress header's second line: "Started today at 9:12 am · up to 50 businesses · quick scan". */
export function metaLine(s: Search, now = new Date()): string {
  const d = new Date(s.created_at);
  const started = `Started ${sameDay(d, now) ? "today" : dayText(d, now)} at ${clock(d)}`;
  if (isImport(s)) return `${started} · ${s.found_count} ${s.found_count === 1 ? "lead" : "leads"} imported`;
  const size = s.status === "running" ? `up to ${s.max_results} businesses`
    : `${s.found_count} ${s.found_count === 1 ? "business" : "businesses"} found`;
  return [started, size, `${scanLabel(s).toLowerCase()} scan`, ...(s.new_only === 1 ? ["radar run"] : [])].join(" · ");
}

/** "about 3 min left" / "under a minute left". */
export const leftText = (seconds: number) => (seconds < 60 ? "under a minute left" : `${Math.round(seconds / 60)} min left`);

/** A running row's status text: "Finding listings…" until the listings arrive, then "34 of 50 audited · 3 min left". */
export function runningLine(s: Search, now: number): string {
  if (searchStage(s) === "fetching") return "Finding listings…";
  const eta = estimateRemainingSeconds(s, now);
  return `${s.processed_count} of ${s.found_count} audited${eta === null ? "" : ` · ${leftText(eta)}`}`;
}

/** The share of the bar that is filled: a small stub while listings are being found, then audited / found. */
export function barPercent(s: Search): number {
  const stage = searchStage(s);
  if (stage === "done") return 100;
  if (stage === "fetching") return 12;
  return s.found_count > 0 ? Math.min(100, Math.round((s.processed_count / s.found_count) * 100)) : 0;
}

/** Why a search did not finish, in a line a person can read. */
export function failureReason(s: Pick<Search, "error">): string {
  const e = (s.error ?? "").trim();
  if (!e) return "Something went wrong";
  if (e === STOPPED_ERROR) return "Stopped before it finished";
  if (e === "spend limit") return "Monthly spend limit reached";
  return e.length > 140 ? `${e.slice(0, 139)}…` : e;
}

/** The radar that schedules this search's market, if any (a radar is unique per location and business type). */
export function radarFor(s: Pick<Search, "location" | "business_type">, radars: Radar[]): Radar | null {
  const key = (loc: string, type: string) => `${loc.trim().toLowerCase()}|${type.trim().toLowerCase()}`;
  return radars.find((r) => key(r.location, r.business_type) === key(s.location, s.business_type)) ?? null;
}
export const radarLabel = (r: Radar) => (r.enabled === 1 ? `Every ${r.interval_days}d` : "Paused");

export interface HistoryFilters { q: string; status: "any" | RunState; scan: "any" | "quick" | "full"; started: "7" | "30" | "90" | "all" }
export const DEFAULT_HISTORY_FILTERS: HistoryFilters = { q: "", status: "any", scan: "any", started: "90" };
export const STARTED_OPTIONS: { value: HistoryFilters["started"]; label: string }[] = [
  { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "all", label: "All time" },
];

/** Applies the history filters. The text box matches the title; an import is neither a quick nor a full scan. */
export function filterSearches(rows: Search[], f: HistoryFilters, now = new Date()): Search[] {
  const q = f.q.trim().toLowerCase();
  const since = f.started === "all" ? 0 : now.getTime() - Number(f.started) * 86_400_000;
  return rows.filter((s) =>
    (!q || searchTitle(s).toLowerCase().includes(q))
    && (f.status === "any" || runState(s) === f.status)
    && (f.scan === "any" || (!isImport(s) && scanLabel(s).toLowerCase() === f.scan))
    && new Date(s.created_at).getTime() >= since);
}

/** "$0.80". */
export const usd = (n: number) => `$${n.toFixed(2)}`;

// ---- a search's results ----

export type RowStatus = "audited" | "auditing" | "queued" | "failed" | "idle";
/** Leads start five at a time, so about that many are being audited at once. */
const IN_FLIGHT = 5;

/** Audited leads first, best score first; then the ones that could not be audited; then the rest in the order they arrived. */
export function sortResults(rows: LeadRow[]): LeadRow[] {
  const rank = (r: LeadRow) => (r.score !== null ? 0 : r.business.last_error ? 1 : 2);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || (rank(a.r) === 0 ? (b.r.score ?? 0) - (a.r.score ?? 0) : 0) || a.i - b.i).map((x) => x.r);
}

/**
 * Where each lead is in the audit. A lead with an audit is audited; one that failed has an error; of the rest, the first few are
 * being audited and the others queued while the search runs. When it is not running, a lead with no audit simply was not audited.
 */
export function rowStatuses(sorted: LeadRow[], running: boolean): RowStatus[] {
  let waiting = 0;
  return sorted.map((r) => {
    if (r.score !== null) return "audited";
    if (r.business.last_error) return "failed";
    return running ? (waiting++ < IN_FLIGHT ? "auditing" : "queued") : "idle";
  });
}

export interface TierCounts { hot: number; warm: number; cool: number; noWebsite: number; failed: number }
/** The five boxes on the progress card. "No website" overlaps the tiers: a business with no site is usually Hot. */
export function tierCounts(rows: LeadRow[]): TierCounts {
  const c: TierCounts = { hot: 0, warm: 0, cool: 0, noWebsite: 0, failed: 0 };
  for (const r of rows) {
    if (!r.business.website_url) c.noWebsite++;
    if (r.score === null) { if (r.business.last_error) c.failed++; continue; }
    if (r.score >= HOT_AT) c.hot++; else if (r.score >= WARM_AT) c.warm++; else c.cool++;
  }
  return c;
}

/** Hot leads that only had a quick scan: what the "Full scan" button runs. */
export const fullScanTargets = (rows: LeadRow[]) => rows.filter((r) => r.scan_stage === "quick" && r.score !== null && r.score >= HOT_AT);
export const fullScanCost = (n: number) => Math.round(n * PER_LEAD_COST * 100) / 100;
export const fullScanButtonText = (n: number) => `Full scan ${n} hot ${n === 1 ? "lead" : "leads"} · ${usd(fullScanCost(n))}`;
