import { Link } from "react-router-dom";
import Icon from "../Icon";
import { Card, Chip } from "../ds";
import { WATCHED_HEADING, watchedLine } from "../../videoViewsView";
import type { Part, WatchedLead } from "./useHome";

/** Leads who watched their video at least halfway this week and have not replied. Nothing to show means no card: it only appears when there is someone to follow up. */
export default function WatchedCard({ watched, onRetry }: { watched: Part<WatchedLead[]>; onRetry: () => void }) {
  const rows = watched.data;
  if (!rows && !watched.error) return null; // still loading
  if (rows && rows.length === 0) return null;
  const now = new Date();
  return (
    <Card icon="eye" title={WATCHED_HEADING} id="watched" className="hox-card" flush note="A warm moment to follow up">
      {!rows ? (
        <div className="hox-alert" role="alert"><span>{watched.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <ul className="hox-rows">
          {rows.map((w) => (
            <li key={w.businessId} className="hox-row-wrap">
              <div className="hox-row">
                <span className="ds-tile positive" aria-hidden="true"><Icon name="eye" size={16} /></span>
                <div className="hox-row-main">
                  <p className="hox-row-title"><span className="hox-what">{w.name}</span></p>
                  <p className="hox-row-sub">{watchedLine(w, now)}</p>
                </div>
                <div className="hox-row-acts">
                  <Chip tone="positive">{w.maxPct}% watched</Chip>
                  <Link to={`/leads/${w.businessId}`} className="btn sm">Open lead</Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
