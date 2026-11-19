import { Link } from "react-router-dom";
import Icon from "../Icon";
import { safeMeetUrl } from "../../bookingView";
import { callWhen, upcomingCalls, type CallRow } from "../../callsView";
import type { Part } from "./useHome";

/** The next 7 days of confirmed calls: the lead, when (Pacific time), the Meet link and a link to the lead page. No card when there is nothing booked. */
export default function CallsCard({ calls, onRetry }: { calls: Part<CallRow[]>; onRetry: () => void }) {
  const rows = calls.data;
  if (!rows && !calls.error) return null; // still loading
  const upcoming = rows ? upcomingCalls(rows, new Date()) : [];
  if (rows && upcoming.length === 0) return null;
  return (
    <section className="hm-card hm-calls" id="calls" aria-labelledby="hm-calls-h">
      <header className="hm-card-head">
        <Icon name="calendar" size={16} />
        <h2 id="hm-calls-h">Calls this week</h2>
      </header>
      {!rows ? (
        <div className="hm-state sm" role="alert"><p>{calls.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <ul className="hm-events">
          {upcoming.map(({ label, booking: c }) => {
            const meet = safeMeetUrl(c.meetUrl);
            return (
              <li key={c.id} className="hm-event">
                <span className={`hm-tile sm ${label === "later" ? "neutral" : "positive"}`} aria-hidden="true"><Icon name="calendar" size={14} /></span>
                <div className="hm-main">
                  <p className="hm-ev-title"><Link to={`/leads/${c.businessId}`}>{c.businessName}</Link></p>
                  <p className="hm-ev-sub">
                    {callWhen(c.startAt, label)} · {c.contactName}
                    {meet && <> · <a href={meet} target="_blank" rel="noreferrer">Meet link</a></>}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
