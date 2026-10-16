import { Link } from "react-router-dom";
import Icon from "../Icon";
import { ago, recentView, type TodaySummary } from "../../todayHome";
import type { Part } from "./useHome";

/** The latest events across all leads: stage changes, notes, drafts, scans. The sidebar's Activity link lands here. */
export default function ActivityCard({ summary, onRetry }: { summary: Part<TodaySummary>; onRetry: () => void }) {
  const recent = summary.data?.recent ?? null;
  return (
    <section className="hm-card hm-activity" id="activity" aria-labelledby="hm-activity-h">
      <header className="hm-card-head">
        <Icon name="clock" size={16} />
        <h2 id="hm-activity-h">Activity</h2>
        <span className="hm-head-note small">Latest across all leads</span>
      </header>
      {!recent && summary.error ? (
        <div className="hm-state sm" role="alert"><p>{summary.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !recent ? (
        <ul className="hm-events" aria-busy="true" aria-label="Loading activity">
          {[0, 1, 2].map((i) => <li key={i} className="hm-event" aria-hidden="true"><i className="hm-skel" style={{ width: 28, height: 28, borderRadius: 8 }} /><div className="hm-main"><i className="hm-skel" style={{ width: `${40 - i * 6}%`, height: 13, marginBottom: 6 }} /><i className="hm-skel" style={{ width: "22%", height: 12 }} /></div></li>)}
        </ul>
      ) : recent.length === 0 ? (
        <div className="hm-state sm" role="status"><p>Nothing yet. Notes, stage changes, drafts and scans across your leads will show up here.</p></div>
      ) : (
        <ul className="hm-events">
          {recent.map((a) => {
            const v = recentView(a);
            return (
              <li key={a.id} className="hm-event">
                <span className={`hm-tile sm ${v.tone}`} aria-hidden="true"><Icon name={v.icon} size={14} /></span>
                <div className="hm-main">
                  <p className="hm-ev-title">{v.title}</p>
                  <p className="hm-ev-sub"><Link to={`/leads/${a.businessId}?tab=activity`}>{a.businessName}</Link>{v.detail ? <> · <span>{v.detail}</span></> : null}</p>
                </div>
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>{ago(a.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
