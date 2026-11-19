import { Link } from "react-router-dom";
import Icon from "../Icon";
import { WATCHED_HEADING, watchedLine } from "../../videoViewsView";
import type { Part, WatchedLead } from "./useHome";

/** Leads who watched their video at least halfway this week and have not replied. Nothing to show means no card: it only appears when there is someone to follow up. */
export default function WatchedCard({ watched, onRetry }: { watched: Part<WatchedLead[]>; onRetry: () => void }) {
  const rows = watched.data;
  if (!rows && !watched.error) return null; // still loading
  if (rows && rows.length === 0) return null;
  const now = new Date();
  return (
    <section className="hm-card hm-watched" id="watched" aria-labelledby="hm-watched-h">
      <header className="hm-card-head">
        <Icon name="eye" size={16} />
        <h2 id="hm-watched-h">{WATCHED_HEADING}</h2>
      </header>
      {!rows ? (
        <div className="hm-state sm" role="alert"><p>{watched.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <ul className="hm-events">
          {rows.map((w) => (
            <li key={w.businessId} className="hm-event">
              <span className="hm-tile sm positive" aria-hidden="true"><Icon name="eye" size={14} /></span>
              <div className="hm-main">
                <p className="hm-ev-title"><Link to={`/leads/${w.businessId}`}>{w.name}</Link></p>
                <p className="hm-ev-sub">{watchedLine(w, now)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
