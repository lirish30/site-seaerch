import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, careApi } from "../api";
import { dayLabel } from "../careReportPageView";
import { ledgerBar, statusChip, statusTone, type ReportRow } from "../careReportsView";
import { latestOnly } from "../clientView";
import Icon from "../components/Icon";
import { LedgerBar } from "../components/client/CareEditHours";
import { periodLabel } from "../../worker/sop/cadence";
import type { CareRow } from "../../worker/monitoring/fleet";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const SUMMARY_MAX = 600;
const RECOMMENDATION_MAX = 300;

/** The report's link in a box to select, and a button that copies it. A copy that is refused says so and leaves the link to copy by hand. */
function LinkBox({ link }: { link: string }) {
  const [note, setNote] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(link); setNote("Link copied."); }
    catch { setNote("Could not copy: select the link and copy it by hand."); }
  }
  return (
    <div className="rp-link">
      <label className="rp-link-label small" htmlFor={`link-${link.slice(-12)}`}>Link to the report page</label>
      <div className="rp-link-row">
        <input id={`link-${link.slice(-12)}`} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" size={16} />Copy link</button>
      </div>
      {note && <p className="small muted" role="status">{note}</p>}
    </div>
  );
}

/** The two boxes for a `ready` report. The server's words show again after a save; Save is off until something changed. */
function WordsForm({ r, onSaved }: { r: ReportRow; onSaved: (next: ReportRow) => void }) {
  const [summary, setSummary] = useState(r.summary);
  const [recommendation, setRecommendation] = useState(r.recommendation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSummary(r.summary); setRecommendation(r.recommendation); }, [r.summary, r.recommendation]);
  const dirty = summary.trim() !== r.summary || recommendation.trim() !== r.recommendation;
  async function save() {
    if (busy || !dirty) return;
    setBusy(true); setError(""); setSaved(false);
    try { onSaved(await careApi.editReport(r.id, { summary, recommendation })); setSaved(true); }
    catch (e) { setError(sentence(e, "Couldn’t save the words. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="rp-words">
      <label htmlFor={`sum-${r.id}`}><b>Summary</b> <span className="muted small">what the client reads in the mail ({summary.length} of {SUMMARY_MAX})</span></label>
      <textarea id={`sum-${r.id}`} rows={4} maxLength={SUMMARY_MAX} value={summary} onChange={(e) => { setSummary(e.target.value); setSaved(false); }} />
      <label htmlFor={`rec-${r.id}`}><b>Recommendation</b> <span className="muted small">on the report page ({recommendation.length} of {RECOMMENDATION_MAX})</span></label>
      <textarea id={`rec-${r.id}`} rows={2} maxLength={RECOMMENDATION_MAX} value={recommendation} onChange={(e) => { setRecommendation(e.target.value); setSaved(false); }} />
      <div className="rp-actions">
        <button type="button" className="btn primary" aria-disabled={busy || !dirty} onClick={() => void save()}>Save my words</button>
        {saved && <span className="small muted" role="status">Saved. The card on Today shows these words now.</span>}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

function ReportCard({ r, onChanged }: { r: ReportRow; onChanged: (next: ReportRow) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function revoke() {
    if (busy) return;
    setBusy(true); setError("");
    try { onChanged(await careApi.revokeReport(r.id)); setAsking(false); }
    catch (e) { setError(sentence(e, "Couldn’t take it back. Try again.")); }
    finally { setBusy(false); }
  }
  const bar = r.status === "revoked" || r.status === "cancelled" ? null : ledgerBar(r.ledger);
  return (
    <li className="cl-card rp-card">
      <div className="cr-card-head">
        <h2 className="cr-name"><Link to={`/clients/${encodeURIComponent(r.clientId)}`}>{r.client || "Client"}</Link></h2>
        <span className={`badge2${statusTone(r.status) ? ` ${statusTone(r.status)}` : ""}`}><i className="dot" aria-hidden="true" />{statusChip(r.status)}</span>
      </div>
      <p className="cr-meta small">
        {r.test && <span className="badge2 outline">Test</span>}
        {r.sentOn && <span>Sent {dayLabel(r.sentOn) ?? r.sentOn}</span>}
        {r.status === "sent" && <span>{r.views === 0 ? "Not opened yet" : `Opened ${r.views} ${r.views === 1 ? "time" : "times"}`}</span>}
      </p>
      {bar && <LedgerBar bar={bar} label="Edit hours used that month" />}
      {r.status === "collecting" && <p className="muted small">The numbers are being collected and the words written. This card changes when they are ready.</p>}
      {r.status === "ready" && (
        <>
          <WordsForm r={r} onSaved={onChanged} />
          <p className="small">Approve it on <Link to="/today">Today</Link> to send it. Nothing is mailed before that.</p>
        </>
      )}
      {r.status === "sent" && (
        <>
          <p className="rp-text">{r.summary}</p>
          {r.recommendation && <p className="rp-text small muted">Recommendation: {r.recommendation}</p>}
        </>
      )}
      {(r.status === "revoked" || r.status === "cancelled") && <p className="muted small">{r.status === "revoked" ? "You took this report back. Its link no longer opens." : "This report was cancelled and never went out."}</p>}
      {r.link && <LinkBox link={r.link} />}
      {(r.status === "ready" || r.status === "sent") && (
        asking ? (
          <div className="rp-actions" role="group" aria-label="Take this report back?">
            <span className="small">Its link will stop working{r.status === "sent" ? ", even for the client who has it" : ""}.</span>
            <button type="button" className="btn" aria-disabled={busy} onClick={() => void revoke()}>Yes, take it back</button>
            <button type="button" className="btn-plain" onClick={() => setAsking(false)}>Keep it</button>
          </div>
        ) : <button type="button" className="btn rp-revoke" onClick={() => setAsking(true)}>Revoke</button>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

/** A Care client with no report for the month yet, with the button that makes it now. A refusal is shown as the server's sentence. */
function Missing({ c, onBuilt }: { c: CareRow; onBuilt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function build() {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.buildReport(c.businessId); await onBuilt(); }
    catch (e) { setError(sentence(e, "Couldn’t start the report. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <li className="rp-missing">
      <span className="rp-missing-name"><Link to={`/clients/${encodeURIComponent(c.businessId)}`}>{c.name}</Link></span>
      <button type="button" className="btn" aria-disabled={busy} onClick={() => void build()}>Build now</button>
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

/** The month's Care reports: each client's report with its status, the words to edit while it is ready, the link to copy, Revoke, and a Build now for the clients that have none yet. */
export default function CareReports() {
  const [period, setPeriod] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [fleet, setFleet] = useState<CareRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const [list, clients] = await Promise.all([careApi.reports(), careApi.fleet().catch(() => null)]);
      if (!guard.isLatest(ticket)) return;
      setPeriod(list.period); setReports(list.reports); setFleet(clients); setFailed(false);
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const replace = (next: ReportRow) => setReports((rs) => rs && rs.map((r) => (r.id === next.id ? next : r)));
  const withReport = new Set((reports ?? []).map((r) => r.clientId));
  const missing = (fleet ?? []).filter((c) => !withReport.has(c.businessId) && c.careLabel !== null);
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Care reports</h1>
          <p>{period ? `${periodLabel("monthly", period)}. ` : ""}The monthly report each Care client gets. A report goes out only after you approve it on Today.</p>
        </div>
        <div className="header-actions">
          <Link className="btn" to="/care">Health</Link>
          <Link className="btn" to="/care/updates">Updates</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the reports{reports ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {reports === null && !failed && <p className="muted">Loading…</p>}
        {reports !== null && reports.length === 0 && missing.length === 0 && <p className="muted">No report for this month yet. Reports start by themselves in the first days of the month.</p>}
        {reports !== null && reports.length > 0 && <ul className="cr-board">{reports.map((r) => <ReportCard key={r.id} r={r} onChanged={replace} />)}</ul>}
        {missing.length > 0 && (
          <section className="cl-card rp-missing-card" aria-label="Clients with no report yet">
            <h2>No report yet</h2>
            <p className="muted small">These clients are on Care but have no report for this month. Build now makes it straight away instead of waiting for the daily start.</p>
            <ul className="rp-missing-list">{missing.map((c) => <Missing key={c.businessId} c={c} onBuilt={load} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}
