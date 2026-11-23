import { Link } from "react-router-dom";
import { Card, Meter } from "../ds";
import { capacityRows, clientsLine, hoursText, stateNote } from "../../capacityView";
import type { Capacity } from "../../../worker/capacity/compute";
import type { Part } from "./useHome";

/** Your booked hours for this week and the next three against the weekly limit, and how many live clients you carry. It only reports: nothing here blocks any work. */
export default function CapacityCard({ capacity, onRetry }: { capacity: Part<Capacity>; onRetry: () => void }) {
  const c = capacity.data;
  const rows = c ? capacityRows(c) : [];
  const note = c ? stateNote(c.state) : null;
  const clients = c ? clientsLine(c.clients) : null;
  return (
    <Card icon="clock" title="Your hours" id="capacity" className="hox-card" note={<Link to="/settings/work" className="hox-note-link" title="Change the limits">Limits</Link>}>
      {!c && capacity.error ? (
        <div className="hox-alert inline" role="alert"><span>{capacity.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !c ? (
        <i className="hox-skel" style={{ width: "70%", height: 18 }} />
      ) : (
        <>
          <p className={`hox-cap-line ${c.state}`} role={c.state === "ok" ? undefined : "status"}>{c.sentence}</p>
          {note && <p className={`hox-caption ${c.state === "over" ? "critical" : "warning"}`}>{note}</p>}
          <ul className="hox-meters" aria-label="Booked hours by week">
            {rows.map((r) => (
              <li key={r.label}>
                <span>{r.label}</span>
                <Meter value={Number(r.booked)} max={Number(r.limit) || 1} tone={r.over ? "critical" : r.pct >= 80 ? "warning" : "neutral"} label={`${r.label}: ${r.booked} of ${r.limit} hours`} />
                <b>{r.booked} of {r.limit} h</b>
              </li>
            ))}
            {clients && (
              <li>
                <span>Clients</span>
                <Meter value={c.clients.count} max={c.clients.limit || 1} tone={clients.full ? "critical" : "positive"} label={clients.text} />
                <b>{c.clients.count} of {c.clients.limit}</b>
              </li>
            )}
          </ul>
          {c.carryOverMinutes > 0 && <p className="hox-caption">{hoursText(c.carryOverMinutes)} hours carried over from late work, counted in this week.</p>}
          {clients?.full && <p className="hox-caption critical">{clients.text}, at your limit.</p>}
        </>
      )}
    </Card>
  );
}
