import { Link } from "react-router-dom";
import type { BestOffer } from "../types";
import Icon from "./Icon";
import { Severity } from "./Score";

/** The one service this audit argues for first, the findings that argue for it, and the button that starts the email. */
export default function BestOfferCard({ offer, fallbackName, onWriteEmail, canWrite = true }: {
  offer: BestOffer | null; fallbackName: string; onWriteEmail: () => void; canWrite?: boolean;
}) {
  const s = offer?.service;
  const because = offer?.because ?? [];
  return (
    <section className="section-card pitch" aria-label="Recommended pitch">
      <div className="kick">
        <Icon name="sparkles" size={16} />
        <p className="kicker">Recommended pitch</p>
        {because.length > 0 && <small>Picked from the weakest areas</small>}
      </div>
      <h2>{s?.name ?? fallbackName}</h2>
      {s?.summary && <p>{s.summary}</p>}
      {(s?.first_engagement || (s?.prerequisites.length ?? 0) > 0) && (
        <div className="pitch-boxes">
          {s?.first_engagement && <div className="mini-box"><span className="lbl">First engagement</span><p>{s.first_engagement}</p></div>}
          {s && s.prerequisites.length > 0 && <div className="mini-box"><span className="lbl">Needs from them</span><p>{s.prerequisites.join(", ")}</p></div>}
        </div>
      )}
      {s && s.deliverables.length > 0 && <div className="mini-box"><span className="lbl">What you'd deliver</span><ul>{s.deliverables.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <div className="why">
        <p className="lbl">Why this pitch</p>
        {because.length > 0
          ? because.map((f, i) => <div key={`${f.code}:${i}`} className="why-row"><Severity severity={f.severity} /><span>{f.evidence}</span></div>)
          : <p className="muted small">{offer ? "No single finding points here; this is the service the audit's overall pitch maps to." : "This is the offer the audit's overall pitch maps to."}</p>}
      </div>
      <div className="pitch-actions">
        <button className="btn-ink" onClick={onWriteEmail} disabled={!canWrite} title={canWrite ? undefined : "Suppressed: drafting is turned off"}><Icon name="send" size={14} />Write email with this pitch</button>
        <Link className="btn-plain" to="/settings">Other services</Link>
      </div>
    </section>
  );
}
