import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { dollars } from "../packagesView";
import { STAGE_LABEL, groupByStage, isStale, type DealCard } from "../pipelineView";

/** The sales board: one column per deal stage, each deal a card linking to its lead. */
export default function Pipeline() {
  const [deals, setDeals] = useState<DealCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    api.get<DealCard[]>("/deals").then(setDeals).catch(() => { setDeals(null); setFailed(true); });
  }, []);
  useEffect(load, [load]);
  const now = new Date();
  const columns = groupByStage(deals ?? []);

  return (
    <div className="pl">
      <header className="page-header">
        <div>
          <h1>Pipeline</h1>
          <p>Every deal by stage. A deal untouched for 7 days is flagged.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={load}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      {failed && <p className="error pl-msg" role="alert">Couldn’t load the pipeline. <button type="button" className="btn sm" onClick={load}>Try again</button></p>}
      {!failed && deals === null && <p className="muted pl-msg">Loading…</p>}
      {deals !== null && (
        <div className="pl-board">
          {columns.map((col) => (
            <section key={col.stage} className="pl-col" aria-label={STAGE_LABEL[col.stage]}>
              <h2>{STAGE_LABEL[col.stage]}<span className="pl-count">{col.deals.length}</span></h2>
              {col.deals.length === 0 && <p className="pl-empty">No deals</p>}
              {col.deals.map((d) => (
                <Link key={d.id} to={`/leads/${d.businessId}`} className="pl-card">
                  <strong>{d.businessName}</strong>
                  {d.valueCents !== null && <span className="muted">{dollars(d.valueCents)}</span>}
                  {isStale(d, now) && <span className="badge2 warning"><i className="dot" />No update in 7 days</span>}
                </Link>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
