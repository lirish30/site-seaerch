import { Link } from "react-router-dom";
import { Badge, LeadScore } from "../Score";
import Icon from "../Icon";
import SnoozeMenu from "./SnoozeMenu";
import { doneLabel, dueBadge, itemLink, itemReason, KIND_VIEW } from "../../todayView";
import type { TodayItem } from "../../types";
import type { LeadFacts, ScanState } from "./useHome";

/** One thing to do: what it is, why, the lead's score, the main action, Done and Snooze. */
export default function UpNextRow({ item, facts, fullScanCostUsd, busy, scan, error, onDone, onSnooze, onFullScan }: {
  item: TodayItem; facts: LeadFacts | undefined; fullScanCostUsd: number | null; busy: boolean; scan: ScanState | undefined; error: string | undefined;
  onDone: () => void; onSnooze: (days: number) => void; onFullScan: () => void;
}) {
  const v = KIND_VIEW[item.kind], badge = dueBadge(item), link = itemLink(item);
  return (
    <li className="hm-row">
      <span className={`hm-tile ${v.tone}`} aria-hidden="true"><Icon name={v.icon} size={16} /></span>
      <div className="hm-main">
        <p className="hm-name">
          <Link to={`/leads/${item.businessId}`} title={item.businessName}>{item.businessName}</Link>
          <span className="hm-kind">{v.label}</span>
        </p>
        <p className="hm-reason">{itemReason(item, { contactedAt: facts?.contactedAt, score: facts?.score, fullScanCostUsd })}</p>
        {error && <p className="hm-err" role="alert">{error}</p>}
      </div>
      <div className="hm-acts">
        {badge && <Badge tone={badge.tone} dot>{badge.label}</Badge>}
        {facts?.score != null && <LeadScore score={facts.score} />}
        {link ? (
          <Link to={link} className="btn sm">{v.action}</Link>
        ) : (
          <button type="button" className="btn sm primary" disabled={busy || scan === "started"} onClick={onFullScan}>
            {scan === "starting" ? "Starting…" : scan === "started" ? "Scan started" : v.action}
          </button>
        )}
        <button type="button" className="hm-icon-btn" aria-label={doneLabel(item.businessName)} title="Done: hide for a week" disabled={busy} onClick={onDone}><Icon name="check" size={14} /></button>
        <SnoozeMenu name={item.businessName} disabled={busy} onPick={onSnooze} />
      </div>
    </li>
  );
}
