import type { BestOffer } from "../types";
import EvidenceBadge from "./EvidenceBadge";

/** The one service this audit argues for first, and the findings that argue for it. */
export default function BestOfferCard({ offer, auditCreatedAt }: { offer: BestOffer; auditCreatedAt: string }) {
  const { service: s, because } = offer;
  return (
    <section className="best-offer" aria-label="Best first offer">
      <p className="best-offer-kicker small">Best first offer</p>
      <h3>{s.name}</h3>
      {s.summary && <p>{s.summary}</p>}
      {s.first_engagement && <p><strong>First engagement:</strong> {s.first_engagement}</p>}
      {s.deliverables.length > 0 && <><h4>Deliverables</h4><ul>{s.deliverables.map((x) => <li key={x}>{x}</li>)}</ul></>}
      {s.prerequisites.length > 0 && <><h4>Needs from the client</h4><ul>{s.prerequisites.map((x) => <li key={x}>{x}</li>)}</ul></>}
      <h4>Why this one</h4>
      {because.length > 0 ? (
        <ul className="top-issues">
          {because.map((f, i) => (
            <li key={`${f.code}:${i}`} className={`finding sev-${f.severity}`}>
              <div>
                <p className="finding-evidence"><span className={`sev-dot sev-${f.severity}`} />{f.evidence}</p>
                <EvidenceBadge finding={f} auditCreatedAt={auditCreatedAt} stale={!!f.stale} />
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No single finding points here; this is the service the audit's overall pitch maps to.</p>}
    </section>
  );
}
