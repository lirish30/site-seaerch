import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import Icon from "../Icon";
import type { IconName } from "../iconMarkup";
import { callWhen, upcomingCalls, type CallRow } from "../../callsView";
import { callsStat, waitingStat, type TodaySummary } from "../../todayHome";
import type { ApprovalItem } from "../../approvalsView";
import type { TodayItem } from "../../types";
import type { Freedom, Part } from "./useHome";

type Tone = "positive" | "warning" | "signal" | "muted";

/** One number card (Figma KPI, 57:4019): icon + label, a 36px number, one coloured line that says what it means. */
function Kpi({ icon, label, value, sub, tone, error, onRetry, href }: {
  icon: IconName; label: string; value: ReactNode | null; sub: ReactNode; tone: Tone; error?: string; onRetry: () => void; href?: string;
}) {
  const body = (
    <>
      <p className="hox-kpi-label"><Icon name={icon} size={16} />{label}</p>
      {value !== null ? <p className="hox-kpi-num">{value}</p>
        : error ? <p className="hox-kpi-num dim" aria-hidden="true">–</p>
        : <p className="hox-kpi-num" aria-hidden="true"><i className="hox-skel" style={{ width: 56, height: 32 }} /></p>}
      {value !== null ? <p className={`hox-kpi-sub ${tone}`}>{sub}</p>
        : error ? <p className="hox-kpi-sub muted">Couldn't load. <button type="button" className="hox-link" onClick={onRetry}>Try again</button></p>
        : <p className="hox-kpi-sub" aria-hidden="true"><i className="hox-skel" style={{ width: 110, height: 12 }} /></p>}
    </>
  );
  return href && value !== null ? <Link className="hox-kpi link" to={href}>{body}</Link> : <article className="hox-kpi">{body}</article>;
}

/** The four headline numbers: what is waiting on you, recurring revenue, who is talking to you, and calls this week. */
export default function KpiCards({ summary, approvals, items, calls, freedom, onRetry }: {
  summary: Part<TodaySummary>; approvals: Part<ApprovalItem[]>; items: Part<TodayItem[]>; calls: Part<CallRow[]>; freedom: Part<Freedom>; onRetry: () => void;
}) {
  const waiting = approvals.data && items.data ? waitingStat(approvals.data.map((a) => a.kind), items.data.length) : null;
  const f = freedom.data;
  const pct = f && f.targetCents > 0 ? Math.round((100 * f.mrrCents) / f.targetCents) : null;
  const up = calls.data ? upcomingCalls(calls.data, new Date()).map((u) => ({ booking: u.booking, when: callWhen(u.booking.startAt, u.label) })) : null;
  const c = up ? callsStat(up) : null;
  const s = summary.data;
  const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
  return (
    <section className="hox-kpis" aria-label="Key numbers">
      <Kpi icon="inbox" label="Waiting on you" value={waiting ? waiting.total : null} sub={waiting?.sub} tone={waiting && waiting.total > 0 ? "warning" : "positive"}
        error={approvals.error || items.error} onRetry={onRetry} href={waiting && waiting.total > 0 ? "#needs" : undefined} />
      <Kpi icon="trending" label="Monthly recurring" value={f ? dollars(f.mrrCents) : null}
        sub={f && pct !== null ? `${pct}% of your ${dollars(f.targetCents)} goal` : "Billed every month"} tone="positive" error={freedom.error} onRetry={onRetry} />
      {/* With nobody talking to you yet, the slot shows the drafts that would start those conversations instead of a 0. */}
      {s && s.replied.total === 0 && s.drafts.ready > 0
        ? <Kpi icon="send" label="Drafts ready to send" value={s.drafts.ready} sub={s.drafts.waiting > 0 ? `${s.drafts.waiting} waiting 2+ days` : "Send them from Outreach"}
            tone={s.drafts.waiting > 0 ? "warning" : "muted"} onRetry={onRetry} href="/outreach" />
        : <Kpi icon="mail" label="In conversation" value={s ? s.replied.total : null}
            sub={s ? (s.replied.thisWeek > 0 ? `${s.replied.thisWeek} replied this week` : "Leads who replied to you") : null}
            tone={s && s.replied.thisWeek > 0 ? "positive" : "muted"} error={summary.error} onRetry={onRetry} />}
      {/* No calls booked: show the size of the pipeline those calls come from. */}
      {c && c.count === 0 && s && s.totalLeads > 0
        ? <Kpi icon="users" label="Leads" value={s.totalLeads.toLocaleString("en-US")} sub={`${s.pipeline.new} new · ${s.pipeline.reviewed} reviewed · no calls booked`} tone="muted" onRetry={onRetry} href="/leads" />
        : <Kpi icon="calendar" label="Calls this week" value={c ? c.count : null} sub={c?.sub} tone="muted" error={calls.error} onRetry={onRetry} href={c && c.count > 0 ? "#calls" : undefined} />}
    </section>
  );
}
