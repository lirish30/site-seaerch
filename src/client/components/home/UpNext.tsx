import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../Icon";
import UpNextRow from "./UpNextRow";
import { filterEmpty, filterItems, filterPills, type KindFilter } from "../../todayView";
import type { TodaySummary } from "../../todayHome";
import type { TodayItem } from "../../types";
import type { LeadFacts, Part, ScanState } from "./useHome";

const VISIBLE = 8;

interface Props {
  items: Part<TodayItem[]>; leads: Part<Map<string, LeadFacts>>; summary: Part<TodaySummary>;
  busy: ReadonlySet<string>; scans: Readonly<Record<string, ScanState>>; errs: Readonly<Record<string, string>>;
  onDone: (i: TodayItem) => void; onSnooze: (i: TodayItem, days: number) => void; onFullScan: (i: TodayItem) => void; onRetry: () => void;
}

/** The "Up next" card: the queue of follow-ups, unsent drafts, stalled deals, quick scans and saved leads, filtered by kind. */
export default function UpNext(p: Props) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const [expanded, setExpanded] = useState(false);
  const all = p.items.data;
  const pills = filterPills(all ?? []);
  // A pill that has just emptied (its last item was done) falls back to All instead of showing a dead filter.
  const active: KindFilter = pills.some((x) => x.key === filter) ? filter : "all";
  const matching = all ? filterItems(all, active) : [];
  // A long queue shows its first rows; the rest are one click away.
  const shown = expanded ? matching : matching.slice(0, VISIBLE);
  // Rows wait for the score chips so they do not jump when those arrive; if the scores fail, rows show without them.
  const ready = all !== null && (p.leads.data !== null || p.leads.error !== "");
  const noLeads = p.summary.data?.totalLeads === 0;

  return (
    <section className="hm-card hm-upnext" aria-labelledby="hm-upnext-h">
      <header className="hm-card-head">
        <Icon name="inbox" size={16} />
        <h2 id="hm-upnext-h">Up next</h2>
        <div className="hm-seg" role="group" aria-label="Filter by kind">
          {pills.map((x) => (
            <button key={x.key} type="button" className={active === x.key ? "on" : ""} aria-pressed={active === x.key} onClick={() => setFilter(x.key)}>{x.label}{all ? ` ${x.count}` : ""}</button>
          ))}
        </div>
      </header>
      {p.items.error && !all ? (
        <div className="hm-state" role="alert">
          <p className="hm-state-title">Couldn't load your list</p>
          <p>{p.items.error}</p>
          <button type="button" className="btn sm" onClick={p.onRetry}>Try again</button>
        </div>
      ) : !ready ? (
        <ul className="hm-rows" aria-busy="true" aria-label="Loading your list">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="hm-row" aria-hidden="true">
              <i className="hm-skel" style={{ width: 34, height: 34, borderRadius: 9 }} />
              <div className="hm-main"><i className="hm-skel" style={{ width: `${46 - i * 4}%`, height: 14, marginBottom: 8 }} /><i className="hm-skel" style={{ width: `${62 - i * 5}%`, height: 12 }} /></div>
              <i className="hm-skel" style={{ width: 160, height: 28 }} />
            </li>
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <div className="hm-state" role="status">
          <span className="hm-state-icon"><Icon name={noLeads ? "search" : "check"} size={18} /></span>
          {all!.length === 0 ? (noLeads ? (
            <>
              <p className="hm-state-title">No leads yet</p>
              <p>Run a search and your best prospects will show up here with what to do next.</p>
              <Link to="/" className="btn sm primary">New search</Link>
            </>
          ) : (
            <>
              <p className="hm-state-title">You're all caught up</p>
              <p>Follow-ups that come due, drafts waiting more than two days and promising quick scans will show up here.</p>
              <Link to="/leads" className="btn sm">Browse leads</Link>
            </>
          )) : (
            <>
              <p className="hm-state-title">{filterEmpty(active)}</p>
              <button type="button" className="btn sm" onClick={() => setFilter("all")}>Show everything</button>
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="hm-rows" aria-label="Up next">
            {shown.map((it) => (
              <UpNextRow key={it.id} item={it} facts={p.leads.data?.get(it.businessId)} fullScanCostUsd={p.summary.data?.fullScanCostUsd ?? null}
                busy={p.busy.has(it.id)} scan={p.scans[it.id]} error={p.errs[it.id]}
                onDone={() => p.onDone(it)} onSnooze={(d) => p.onSnooze(it, d)} onFullScan={() => p.onFullScan(it)} />
            ))}
          </ul>
          <p className="hm-foot"><Icon name="info" size={14} />✓ hides an item for a week · the clock snoozes it for 1, 3 or 7 days
            {matching.length > VISIBLE && <button type="button" className="hm-link" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>{expanded ? "Show fewer" : `Show ${matching.length - VISIBLE} more`}</button>}
          </p>
        </>
      )}
      {p.items.error && all && <p className="hm-err hm-foot-err" role="alert">{p.items.error} <button type="button" className="hm-link" onClick={p.onRetry}>Try again</button></p>}
    </section>
  );
}
