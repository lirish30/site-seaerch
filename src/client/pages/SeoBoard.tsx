import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { seoApi, type SeoBoardRow } from "../api";
import { statusTone } from "../careReportsView";
import { latestOnly } from "../clientView";
import Icon from "../components/Icon";
import { boardReportLine, reportChip } from "../seoView";
import { periodLabel } from "../../worker/sop/cadence";
import { sentence } from "../components/client/seo/seoBits";

/** One client's row: what to do next in a sentence, what waits, last month's report, and the button that starts that report now. A refusal is shown as the server's own sentence. */
function Row({ r, period, onBuilt }: { r: SeoBoardRow; period: string; onBuilt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function build() {
    if (busy) return;
    setBusy(true); setError("");
    try { await seoApi.buildReport(r.clientId); await onBuilt(); }
    catch (e) { setError(sentence(e, "Couldn’t start the report. Try again.")); }
    finally { setBusy(false); }
  }
  const tone = r.report ? statusTone(r.report.status) : "";
  return (
    <li className="cl-card sxb-row">
      <div className="cr-card-head">
        <h2 className="cr-name"><Link to={`/clients/${encodeURIComponent(r.clientId)}`}>{r.client || "Client"}</Link></h2>
        {r.report ? <span className={`badge2${tone ? ` ${tone}` : ""}`}><i className="dot" aria-hidden="true" />{reportChip(r.report.status)}</span> : <span className="badge2">No report yet</span>}
      </div>
      <p className="sxb-next"><b>Next:</b> {r.next}</p>
      <p className="cr-meta small">
        <span>{r.draftsWaiting === 0 ? "No drafts waiting" : `${r.draftsWaiting} ${r.draftsWaiting === 1 ? "draft" : "drafts"} waiting`}</span>
        {r.flaggedReviews > 0 && <span className="sxb-flag">{r.flaggedReviews} low-rated {r.flaggedReviews === 1 ? "review" : "reviews"} to answer</span>}
        <span>{boardReportLine(r.report, period)}</span>
      </p>
      <div className="rp-actions">
        <Link className="btn" to={`/clients/${encodeURIComponent(r.clientId)}`}>Open client</Link>
        {r.report === null && <button type="button" className="btn" aria-disabled={busy} onClick={() => void build()}>{busy ? "Starting…" : "Build report now"}</button>}
        {r.report?.status === "ready" && <Link className="btn" to="/today">Approve on Today</Link>}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

/** Local SEO across clients: one row per client whose watch is on, with the next step, the drafts waiting and last month's report. Nothing here posts or publishes: drafts are looked at and copied on the client's page. */
export default function SeoBoard() {
  const [rows, setRows] = useState<SeoBoardRow[] | null>(null);
  const [period, setPeriod] = useState("");
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const r = await seoApi.board();
      if (!guard.isLatest(ticket)) return;
      setRows(r.rows); setPeriod(r.period); setFailed(false);
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Local SEO</h1>
          <p>{period ? `${periodLabel("monthly", period)}. ` : ""}Every client whose watch is on, with what to do next. A report goes out only after you approve it on Today.</p>
        </div>
        <div className="header-actions">
          <Link className="btn" to="/today">Today</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the board{rows ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {rows === null && !failed && <p className="muted">Loading…</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No client has the Local SEO watch on yet. Set a client up from their page: pick the Google listing, add search terms, then take the baseline.</p>}
        {rows !== null && rows.length > 0 && <ul className="cr-board">{rows.map((r) => <Row key={r.clientId} r={r} period={period} onBuilt={load} />)}</ul>}
      </div>
    </div>
  );
}
