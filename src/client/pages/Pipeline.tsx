import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Avatar, Banner, Chip, Empty, Note, PageHeader } from "../components/ds";
import Icon from "../components/Icon";
import { LeadScore } from "../components/Score";
import { dollars } from "../packagesView";
import {
  BOARD_FILTER_LABEL, boardColumns, boardFilterOf, boardSummary, cardPackage, cardStatus, dealHref, type BoardDeal, type CardContext,
} from "../pipelineView";
import type { LeadRow } from "../types";

interface Booking { businessId: string; startAt: string; kind: "discovery" | "recommendation"; meetUrl: string | null }
interface ProposalBrief { current: { sentAt: string | null; expiresAt: string | null; status: string; paidAt: string | null; signedAt: string | null } | null; views: number }

/**
 * The sales board: one column per open stage plus "Won this month", each deal a card that opens its deal page. The sidebar's `?stage=` narrows it to
 * proposals out, booked calls, or won and lost. A deal moves by itself as the work is done (call, recap, proposal, deposit), so there is no dragging.
 */
export default function Pipeline() {
  const [params] = useSearchParams();
  const filter = boardFilterOf(params.get("stage"));
  const [deals, setDeals] = useState<BoardDeal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [proposals, setProposals] = useState<Record<string, ProposalBrief>>({});
  const [newDeal, setNewDeal] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    api.get<BoardDeal[]>("/deals").then(setDeals).catch(() => { setDeals(null); setFailed(true); });
    // Scores and booked calls only add detail to the cards: a failure leaves them out, never the board.
    api.get<LeadRow[]>("/leads?limit=500").then((r) => setLeads(Array.isArray(r) ? r : [])).catch(() => setLeads([]));
    api.get<Booking[]>("/bookings").then((r) => setBookings(Array.isArray(r) ? r : [])).catch(() => setBookings([]));
  }, []);
  useEffect(load, [load]);

  // Where each proposal stands (views, expiry, deposit), for the deals that have one out or are won.
  useEffect(() => {
    if (!deals) return;
    let live = true;
    for (const d of deals.filter((x) => x.stage === "proposal_sent" || x.stage === "won")) {
      api.get<ProposalBrief>(`/deals/${d.id}/proposal`).then((p) => { if (live) setProposals((all) => ({ ...all, [d.id]: p })); }).catch(() => {});
    }
    return () => { live = false; };
  }, [deals]);

  const now = new Date();
  const scores = useMemo(() => new Map(leads.map((l) => [l.business.id, l.score])), [leads]);
  const ctxOf = (d: BoardDeal): CardContext => {
    const p = proposals[d.id];
    const kind = d.stage === "booked" ? "discovery" : "recommendation";
    return {
      booking: bookings.filter((b) => b.businessId === d.businessId && b.kind === kind).sort((a, b) => a.startAt.localeCompare(b.startAt))[0] ?? null,
      proposal: p?.current ? { ...p.current, views: p.views } : null,
    };
  };
  const columns = deals ? boardColumns(deals, filter, now) : [];

  return (
    <div className="ds-page slx-pipeline">
      <PageHeader
        title={filter === "all" ? "Pipeline" : BOARD_FILTER_LABEL[filter]}
        sub={deals && deals.length > 0 ? boardSummary(deals, now, dollars) : "Every deal by stage, from booked call to deposit paid."}
        chips={filter !== "all" ? <Link to="/pipeline" className="slx-filter-chip" title="Show every stage"><Chip tone="outline">Show all stages<Icon name="x" size={12} /></Chip></Link> : undefined}
        actions={<button type="button" className="btn primary" onClick={() => setNewDeal(!newDeal)} aria-expanded={newDeal}><Icon name="plus" size={16} />New deal</button>}
      />
      <div className="ds-body">
        {newDeal && <NewDealPanel leads={leads} deals={deals ?? []} onClose={() => setNewDeal(false)} />}
        {failed && <Banner tone="critical" title="Couldn’t load the pipeline" action={<button type="button" className="btn sm" onClick={load}>Try again</button>}>Check your connection, then try again.</Banner>}
        {!failed && deals === null && <p className="slx-muted">Loading the board…</p>}
        {deals !== null && deals.length === 0 && (
          <div className="ds-card">
            <Empty icon="kanban" title="No deals yet"
              action={<button type="button" className="btn primary" onClick={() => setNewDeal(true)}><Icon name="plus" size={16} />New deal</button>}>
              A deal is one prospect on the way to a signed proposal. It starts when a lead books a call from your email, or when you start one by hand from a lead.
              Then it moves right by itself: call held, recap, recommendation, proposal sent, deposit paid.
            </Empty>
          </div>
        )}
        {deals !== null && deals.length > 0 && (
          <>
            <div className="slx-board" role="list" aria-label="Deal stages">
              {columns.map((col) => (
                <section key={col.key} className="slx-col" role="listitem" aria-label={col.label}>
                  <header className="slx-col-head">
                    <h2>{col.label}</h2><span className="slx-col-count">{col.deals.length}</span>
                    <span className="ds-grow" />
                    {col.totalCents > 0 && <span className="slx-col-total">{dollars(col.totalCents)}</span>}
                  </header>
                  {col.deals.length === 0 && <p className="slx-col-empty">No deals here</p>}
                  {col.deals.map((d) => {
                    const s = cardStatus(d, ctxOf(d), now);
                    const score = scores.get(d.businessId);
                    return (
                      <Link key={d.id} to={dealHref(d)} className="slx-card">
                        <b className="slx-card-name">{d.businessName}</b>
                        <span className="slx-card-pkg">{cardPackage(d)}{d.valueCents !== null && <> · {dollars(d.valueCents)}</>}</span>
                        <span className={`slx-card-status ${s.tone}`}><Icon name={s.icon} size={14} />{s.text}</span>
                        {score !== undefined && <span className="slx-card-score"><LeadScore score={score} /></span>}
                      </Link>
                    );
                  })}
                </section>
              ))}
            </div>
            <Note>Values are first-year: the price up front plus 12 months of anything monthly. A deal moves right by itself as the work gets done, so there is nothing to drag.</Note>
          </>
        )}
      </div>
    </div>
  );
}

/** Start a deal by hand: pick a lead that has no open deal. Leads that book a call get their deal by themselves. */
function NewDealPanel({ leads, deals, onClose }: { leads: LeadRow[]; deals: BoardDeal[]; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [skipCall, setSkipCall] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const taken = new Set(deals.filter((d) => d.stage !== "won" && d.stage !== "lost").map((d) => d.businessId));
  const term = q.trim().toLowerCase();
  const pool = leads.filter((l) => !taken.has(l.business.id) && !l.business.archived_at && (!term || l.business.name.toLowerCase().includes(term)));
  const shown = pool.slice(0, 6);

  async function start(id: string) {
    setBusy(id); setError("");
    try {
      const d = await api.post<{ id: string }>(`/leads/${id}/deal`, skipCall ? { skipCall: true } : {});
      nav(`/deals/${d.id}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn’t start the deal. Try again."); setBusy(null); }
  }

  return (
    <section className="ds-card slx-panel" aria-label="New deal">
      <header className="ds-card-head">
        <Icon name="plus" size={16} /><h2>New deal</h2>
        <span className="ds-card-note">Pick the lead it is for</span>
        <button type="button" className="ds-icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
      </header>
      <div className="ds-card-body">
        <div className="slx-panel-row">
          <label className="slx-search"><Icon name="search" size={14} /><input autoFocus placeholder="Search leads by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" /></label>
          <label className="switch"><input type="checkbox" checked={skipCall} onChange={(e) => setSkipCall(e.target.checked)} /><i />Skip the call and send an agreement</label>
        </div>
        {error && <p className="slx-error" role="alert">{error}</p>}
      </div>
      <div className="ds-card-flush">
        {shown.length === 0 && <p className="ds-empty-line">{leads.length === 0 ? "No leads yet. Run a search to find some." : "No lead without a deal matches that name."}</p>}
        {shown.map((l) => (
          <div key={l.business.id} className="slx-pick-row">
            <Avatar name={l.business.name} />
            <span className="slx-pick-text"><b>{l.business.name}</b><small>{[l.niche, l.bestContact].filter(Boolean).join(" · ") || "No contact yet"}</small></span>
            <LeadScore score={l.score} />
            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void start(l.business.id)}>{busy === l.business.id ? "Starting…" : "Start deal"}</button>
          </div>
        ))}
        {pool.length > shown.length && <p className="ds-empty-line">{pool.length - shown.length} more: type to narrow it down.</p>}
      </div>
    </section>
  );
}
