import { Link } from "react-router-dom";
import Icon from "../Icon";
import { Card, Chip } from "../ds";
import { safeMeetUrl } from "../../bookingView";
import { callWhen, kindLabel, pastCalls, upcomingCalls, type CallRow } from "../../callsView";
import BookingActions from "../BookingActions";
import type { Part } from "./useHome";

/** The next 7 days of confirmed calls: the lead, when (Pacific time), the Meet link, and the call's actions. Calls that started and need an outcome come first. No card when there is nothing booked. */
export default function CallsCard({ calls, onRetry }: { calls: Part<CallRow[]>; onRetry: () => void }) {
  const rows = calls.data;
  if (!rows && !calls.error) return null; // still loading
  const now = new Date();
  const upcoming = rows ? upcomingCalls(rows, now) : [], past = rows ? pastCalls(rows, now) : [];
  if (rows && upcoming.length === 0 && past.length === 0) return null;
  return (
    <Card icon="calendar" title="Calls this week" id="calls" className="hox-card" flush note={rows ? `${upcoming.length} coming up` : undefined}>
      {!rows ? (
        <div className="hox-alert" role="alert"><span>{calls.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <ul className="hox-rows">
          {past.map((c) => (
            <li key={c.id} className="hox-row-wrap">
              <div className="hox-row">
                <span className="ds-tile warning" aria-hidden="true"><Icon name="calendar" size={16} /></span>
                <div className="hox-row-main">
                  <p className="hox-row-title"><span className="hox-what">{kindLabel(c.kind)}</span><Link className="hox-who" to={`/leads/${c.businessId}`}>{c.businessName}</Link></p>
                  <p className="hox-row-sub">{callWhen(c.startAt, "later")} · {c.contactName}</p>
                </div>
                <div className="hox-row-acts"><Chip tone="warning" dot>Needs an outcome</Chip><BookingActions booking={c} onChanged={onRetry} /></div>
              </div>
            </li>
          ))}
          {upcoming.map(({ label, booking: c }) => {
            const meet = safeMeetUrl(c.meetUrl);
            return (
              <li key={c.id} className="hox-row-wrap">
                <div className="hox-row">
                  <span className={`ds-tile ${label === "today" ? "info" : "neutral"}`} aria-hidden="true"><Icon name="calendar" size={16} /></span>
                  <div className="hox-row-main">
                    <p className="hox-row-title"><span className="hox-what">{kindLabel(c.kind)}</span><Link className="hox-who" to={`/leads/${c.businessId}`}>{c.businessName}</Link></p>
                    <p className="hox-row-sub">{callWhen(c.startAt, label)} · {c.contactName}</p>
                  </div>
                  <div className="hox-row-acts">
                    {label === "today" && <Chip tone="info" dot>Today</Chip>}
                    <BookingActions booking={c} onChanged={onRetry} />
                    {meet ? <a className="btn sm" href={meet} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Join Meet</a>
                      : <Link className="btn sm" to={`/leads/${c.businessId}`}>Prep call</Link>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
