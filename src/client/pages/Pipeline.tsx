import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { EmptyState, StatRow } from "../components/PageBits";
import { dollars } from "../packagesView";
import { STAGE_LABEL, dealHref, groupByStage, isStale, type DealCard } from "../pipelineView";

/** The sales board: one column per deal stage, each deal a card linking to its deal page. */
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
      {deals !== null && (() => {
        const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
        const value = open.reduce((n, d) => n + (d.valueCents ?? 0), 0);
        const stale = open.filter((d) => isStale(d, now)).length;
        const won = deals.filter((d) => d.stage === "won").length, lost = deals.filter((d) => d.stage === "lost").length;
        return (
          <div className="pb-page pl-top">
            <StatRow stats={[
              { label: "Open deals", icon: "kanban", value: open.length, sub: open.length ? `${open.filter((d) => d.stage === "proposal_sent").length} with a proposal out` : "None in play" },
              { label: "Open value", icon: "trending", value: dollars(value), sub: open.some((d) => d.valueCents === null) ? "Some deals have no value set" : "What's on the table" },
              { label: "Gone quiet", icon: "clock", value: stale, sub: stale ? "No update in 7 days: follow up" : "Every deal is moving", tone: stale ? "warning" : "positive" },
              { label: "Win rate", icon: "check", value: won + lost ? `${Math.round((won / (won + lost)) * 100)}%` : "—", sub: won + lost ? `${won} won · ${lost} lost` : "Shows after the first close" },
            ]} />
            {deals.length === 0 && (
              <EmptyState icon="kanban" title="No deals yet"
                steps={[
                  { title: "A lead replies", text: "Replies land in Outreach. Book the call from the lead.", to: "/outreach" },
                  { title: "The call makes the deal", text: "Booking a call puts the deal in Call booked with its prep." },
                  { title: "Move it along", text: "Discovery, recommendation and proposal each move it a column right." },
                ]}>
                A deal is one prospect on the way to a signed proposal.
              </EmptyState>
            )}
          </div>
        );
      })()}
      {deals !== null && deals.length > 0 && (
        <div className="pl-board">
          {columns.map((col) => (
            <section key={col.stage} className="pl-col" aria-label={STAGE_LABEL[col.stage]}>
              <h2>{STAGE_LABEL[col.stage]}<span className="pl-count">{col.deals.length}</span></h2>
              {col.deals.some((d) => d.valueCents) && <p className="pl-sum">{dollars(col.deals.reduce((n, d) => n + (d.valueCents ?? 0), 0))}</p>}
              {col.deals.length === 0 && <p className="pl-empty">No deals</p>}
              {col.deals.map((d) => (
                <Link key={d.id} to={dealHref(d)} className="pl-card">
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
