import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../Icon";
import { Empty, Note, Seg } from "../ds";
import ApprovalGroups from "./ApprovalsCard";
import UpNextRow from "./UpNextRow";
import { filterEmpty, filterItems, filterPills, type KindFilter } from "../../todayView";
import { groupApprovals, type ApprovalItem } from "../../approvalsView";
import type { TodaySummary } from "../../todayHome";
import type { TodayItem } from "../../types";
import type { LeadFacts, Part, ScanState } from "./useHome";

const VISIBLE = 8;
/** In the All view, approvals show their first rows so the to-do list below stays in sight. */
const APPROVALS_IN_ALL = 5;
/** The segmented filter: everything, only approvals, or one kind of Up next item. */
export type NeedsFilter = "approvals" | KindFilter;

interface Props {
  items: Part<TodayItem[]>; leads: Part<Map<string, LeadFacts>>; summary: Part<TodaySummary>;
  approvals: Part<ApprovalItem[]>; approvalErrs: Readonly<Record<string, string>>;
  busy: ReadonlySet<string>; scans: Readonly<Record<string, ScanState>>; errs: Readonly<Record<string, string>>;
  filter: NeedsFilter; onFilter: (f: NeedsFilter) => void;
  onDone: (i: TodayItem) => void; onSnooze: (i: TodayItem, days: number) => void; onFullScan: (i: TodayItem) => void;
  onApprove: (a: ApprovalItem, payload?: unknown) => void; onReject: (a: ApprovalItem, note: string) => void; onApproveAll: (items: ApprovalItem[]) => void;
  onRetry: () => void;
}

/**
 * "Needs you" (Figma 57:4054): one card for everything waiting on you. Approvals Claude drafted come first, grouped by kind, then
 * the Up next queue (follow-ups, unsent drafts, stalled deals, quick scans, billing, clients). The segmented control filters it.
 */
export default function NeedsYou(p: Props) {
  const [expanded, setExpanded] = useState(false);
  const all = p.items.data, appr = p.approvals.data;
  const groups = useMemo(() => groupApprovals(appr ?? []), [appr]);
  const pills = filterPills(all ?? []);
  const options = [
    { key: "all" as NeedsFilter, label: "All", count: all || appr ? (all?.length ?? 0) + (appr?.length ?? 0) : undefined },
    ...(appr && appr.length > 0 ? [{ key: "approvals" as NeedsFilter, label: "Approvals", count: appr.length }] : []),
    ...pills.filter((x) => x.key !== "all" && x.count > 0).map((x) => ({ key: x.key as NeedsFilter, label: x.label, count: x.count })),
  ];
  // A filter that has just emptied (its last item was done) falls back to All instead of showing a dead filter.
  const active: NeedsFilter = options.some((o) => o.key === p.filter) ? p.filter : "all";
  const { filter, onFilter } = p;
  useEffect(() => { if (active !== filter && (all || appr)) onFilter(active); }, [active, filter, all, appr, onFilter]);

  const showApprovals = active === "all" || active === "approvals";
  const matching = all && active !== "approvals" ? filterItems(all, active as KindFilter) : [];
  const shown = expanded ? matching : matching.slice(0, VISIBLE);
  // Rows wait for the score chips so they do not jump when those arrive; if the scores fail, rows show without them.
  const ready = all !== null && (p.leads.data !== null || p.leads.error !== "") && (appr !== null || p.approvals.error !== "");
  const noLeads = p.summary.data?.totalLeads === 0;
  const draftsReady = p.summary.data?.drafts.ready ?? 0;
  const apprShown = showApprovals ? groups : [];
  const nothing = ready && apprShown.length === 0 && shown.length === 0;
  const failed = appr ? appr.filter((a) => p.approvalErrs[a.id]) : [];

  return (
    <section className="ds-card hox-needs" id="needs" aria-labelledby="hox-needs-h">
      <header className="ds-card-head hox-needs-head">
        <Icon name="inbox" size={16} />
        <h2 id="hox-needs-h">Needs you</h2>
        {options.length > 1 && <Seg label="Show" options={options} value={active} onChange={onFilter} />}
      </header>
      {(p.items.error && !all) || (p.approvals.error && !appr) ? (
        <div className="hox-alert" role="alert">
          <Icon name="alert" size={16} />
          <span>{p.items.error && !all ? p.items.error : p.approvals.error}</span>
          <button type="button" className="btn sm" onClick={p.onRetry}>Try again</button>
        </div>
      ) : null}
      {!ready && !(p.items.error && !all) ? (
        <ul className="hox-rows" aria-busy="true" aria-label="Loading your list">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="hox-row" aria-hidden="true">
              <i className="hox-skel" style={{ width: 34, height: 34, borderRadius: 9 }} />
              <div className="hox-row-main"><i className="hox-skel" style={{ width: `${46 - i * 4}%`, height: 14, marginBottom: 8 }} /><i className="hox-skel" style={{ width: `${62 - i * 5}%`, height: 12 }} /></div>
              <i className="hox-skel" style={{ width: 120, height: 28 }} />
            </li>
          ))}
        </ul>
      ) : nothing ? (
        (all?.length ?? 0) + (appr?.length ?? 0) > 0 ? (
          <Empty icon="filter" title={active === "approvals" ? "No approvals right now" : filterEmpty(active as KindFilter)} action={<button type="button" className="btn sm" onClick={() => onFilter("all")}>Show everything</button>} />
        ) : noLeads ? (
          <Empty icon="search" title="No leads yet" action={<Link to="/" className="btn sm primary"><Icon name="search" size={14} />Find leads</Link>}>
            Run a search and your best prospects show up here with what to do next.
          </Empty>
        ) : (
          <div className="hox-clear">
            <span className="ds-tile positive big" aria-hidden="true"><Icon name="check" size={18} /></span>
            <div className="hox-clear-text">
              <b>You're all caught up</b>
              <p>Nothing is waiting for your OK and no follow-ups are due. When Claude drafts something, a follow-up comes due or a client needs you, it lands here.</p>
              <div className="hox-clear-acts">
                {draftsReady > 0 && <Link to="/outreach" className="btn sm"><Icon name="send" size={14} />Ready drafts ({draftsReady})</Link>}
                <Link to="/leads" className="btn sm">Browse leads</Link>
                <Link to="/" className="btn sm"><Icon name="search" size={14} />Find more leads</Link>
              </div>
            </div>
          </div>
        )
      ) : (
        <>
          {apprShown.length > 0 && (
            <div id="approvals">
              <ApprovalGroups groups={apprShown} errs={p.approvalErrs} busy={p.busy} onApprove={p.onApprove} onReject={p.onReject} onApproveAll={p.onApproveAll}
                limit={active === "all" ? APPROVALS_IN_ALL : undefined} onShowAll={() => onFilter("approvals")} />
            </div>
          )}
          {shown.length > 0 && (
            <div className="hox-group" role="group" aria-label="To do">
              <div className="hox-group-head"><span>To do<b>{matching.length}</b></span></div>
              <ul className="hox-rows" aria-label="Up next">
                {shown.map((it) => (
                  <UpNextRow key={it.id} item={it} facts={p.leads.data?.get(it.businessId)}
                    busy={p.busy.has(it.id)} scan={p.scans[it.id]} error={p.errs[it.id]}
                    onDone={() => p.onDone(it)} onSnooze={(d) => p.onSnooze(it, d)} onFullScan={() => p.onFullScan(it)} />
                ))}
              </ul>
            </div>
          )}
          <footer className="hox-needs-foot">
            <Note>{shown.length > 0 ? "✓ hides an item for a week. The clock snoozes it for 1, 3 or 7 days." : "Nothing goes out until you approve it here."}</Note>
            {matching.length > VISIBLE && <button type="button" className="hox-link" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>{expanded ? "Show fewer" : `Show ${matching.length - VISIBLE} more`}</button>}
          </footer>
        </>
      )}
      {p.items.error && all && <p className="hox-row-err" role="alert">{p.items.error} <button type="button" className="hox-link" onClick={p.onRetry}>Try again</button></p>}
      {/* Errors are read out as they appear; the same text also sits beside the item that failed. */}
      <div className="sr-only" aria-live="polite" role="status">{failed.map((a) => `${a.title}: ${p.approvalErrs[a.id]}`).join(". ")}</div>
    </section>
  );
}
