import { Link } from "react-router-dom";
import Icon from "../Icon";
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
    <section className="hm-card hm-cap" id="capacity" aria-labelledby="hm-cap-h">
      <header className="hm-card-head">
        <Icon name="clock" size={16} />
        <h2 id="hm-cap-h">Capacity</h2>
        <Link to="/settings/work" className="hm-head-note small" title="Change the limits">Limits</Link>
      </header>
      {!c && capacity.error ? (
        <div className="hm-state sm" role="alert"><p>{capacity.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !c ? (
        <div className="hm-card-body"><i className="hm-skel" style={{ width: "70%", height: 18 }} /></div>
      ) : (
        <div className="hm-card-body">
          <p className={`hm-cap-line ${c.state}`} role={c.state === "ok" ? undefined : "status"}>{c.sentence}</p>
          {note && <p className={`hm-cap-note ${c.state}`}>{note}</p>}
          <ul className="hm-cap-rows" aria-label="Booked hours by week">
            {rows.map((r) => (
              <li key={r.label}>
                <span>{r.label}</span>
                <div className={`hm-meter${r.over ? " over" : ""}`} aria-hidden="true"><i style={{ width: `${r.pct}%` }} /></div>
                <b>{r.booked} of {r.limit}</b>
              </li>
            ))}
          </ul>
          {c.carryOverMinutes > 0 && <p className="hm-cap-sub small">{hoursText(c.carryOverMinutes)} hours carried over from late work, counted in this week.</p>}
          {clients && <p className={`hm-cap-sub small${clients.full ? " over" : ""}`}>{clients.text}{clients.full ? ", at your limit" : ""}</p>}
        </div>
      )}
    </section>
  );
}
