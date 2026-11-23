import { Link } from "react-router-dom";
import { LeadScore } from "../Score";
import Icon from "../Icon";
import { Chip } from "../ds";
import SnoozeMenu from "./SnoozeMenu";
import { doneLabel, dueBadge, itemLink, itemReason, KIND_VIEW } from "../../todayView";
import type { TodayItem } from "../../types";
import type { LeadFacts, ScanState } from "./useHome";

/** One thing to do (Figma "Needs you" row): a tinted tile, what it is and for whom, why, the lead's score, the main action, Done and Snooze. */
export default function UpNextRow({ item, facts, busy, scan, error, onDone, onSnooze, onFullScan }: {
  item: TodayItem; facts: LeadFacts | undefined; busy: boolean; scan: ScanState | undefined; error: string | undefined;
  onDone: () => void; onSnooze: (days: number) => void; onFullScan: () => void;
}) {
  const v = KIND_VIEW[item.kind], badge = dueBadge(item), link = itemLink(item);
  return (
    <li className="hox-row-wrap">
      <div className="hox-row">
        <span className={`ds-tile ${v.tone}`} aria-hidden="true"><Icon name={v.icon} size={16} /></span>
        <div className="hox-row-main">
          <p className="hox-row-title">
            <span className="hox-what">{v.label}</span>
            <Link className="hox-who" to={`/leads/${item.businessId}`} title={item.businessName}>{item.businessName}</Link>
          </p>
          <p className="hox-row-sub">{itemReason(item, { contactedAt: facts?.contactedAt, score: facts?.score })}</p>
        </div>
        <div className="hox-row-acts">
          {badge && <Chip tone={badge.tone} dot>{badge.label}</Chip>}
          {facts?.score != null && <LeadScore score={facts.score} />}
          {link ? (
            <Link to={link} className="btn sm">{v.action}</Link>
          ) : (
            <button type="button" className="btn sm primary" disabled={busy || scan === "started"} onClick={onFullScan}>
              {scan === "starting" ? "Starting…" : scan === "started" ? "Scan started" : v.action}
            </button>
          )}
          <button type="button" className="ds-icon-btn" aria-label={doneLabel(item.businessName)} title="Done: hide for a week" disabled={busy} onClick={onDone}><Icon name="check" size={14} /></button>
          <SnoozeMenu name={item.businessName} disabled={busy} onPick={onSnooze} />
        </div>
      </div>
      {error && <p className="hox-row-err" role="alert"><Icon name="alert" size={14} />{error}</p>}
    </li>
  );
}
