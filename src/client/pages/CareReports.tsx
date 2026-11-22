import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, careApi } from "../api";
import { dayLabel } from "../careReportPageView";
import { ledgerBar, statusChip, statusTone, type ReportRow } from "../careReportsView";
import { latestOnly, moneyLabel } from "../clientView";
import { formatUptime } from "../careView";
import Icon from "../components/Icon";
import { Card, EmptyState, Meter, StatRow } from "../components/PageBits";
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
    <li className="crp-row">
      <span className="crp-name"><Link to={`/clients/${encodeURIComponent(c.businessId)}`}>{c.name}</Link><small>{c.careLabel ?? "Care"} · {c.uptime30 === null ? "no uptime checks yet" : `uptime ${formatUptime(c.uptime30)} over 30 days`}{c.openIncidents.length ? ` · ${c.openIncidents.length} open incident${c.openIncidents.length === 1 ? "" : "s"}` : ""}</small></span>
      <span className={`badge2 ${!c.health.hasData ? "outline" : c.health.band === "good" ? "positive" : c.health.band === "watch" ? "warning" : "critical"}`}><i className="dot" aria-hidden="true" />{c.health.hasData ? `Health ${c.health.score}` : "No health yet"}</span>
      <button type="button" className="btn" aria-disabled={busy} onClick={() => void build()}>{busy ? "Starting…" : "Build now"}</button>
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
  const list = reports ?? [];
  const live = list.filter((r) => r.status !== "revoked" && r.status !== "cancelled");
  const count = (st: ReportRow["status"]) => list.filter((r) => r.status === st).length;
  const ready = count("ready"), sent = count("sent"), collecting = count("collecting");
  const opened = list.filter((r) => r.status === "sent" && r.views > 0).length;
  const due = live.length + missing.length;
  const careMrr = (fleet ?? []).filter((c) => c.careLabel !== null).reduce((n, c) => n + c.mrrCents, 0);
  const loaded = reports !== null;
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Care reports</h1>
          <p>{period ? `${periodLabel("monthly", period)}. ` : ""}The monthly proof each Care client gets that their site was looked after. Nothing goes out until you approve it on Today.</p>
        </div>
        <div className="header-actions">
          <Link className="btn" to="/care">Health</Link>
          <Link className="btn" to="/care/updates">Updates</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="pb-page">
        {failed && <p className="error" role="alert">Couldn’t load the reports{reports ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {!loaded && !failed && <p className="muted">Loading…</p>}
        {loaded && (
          <StatRow stats={[
            { label: "Reports this month", value: <>{sent}<small>of {due} sent</small></>, sub: <Meter value={sent} max={Math.max(1, due)} label={`${sent} of ${due} sent`} /> },
            { label: "Waiting for your OK", value: ready, sub: ready ? <Link to="/today">Approve on Today</Link> : "Nothing to approve", tone: ready ? "warning" : "" },
            { label: "Opened by clients", value: sent ? `${opened} of ${sent}` : "—", sub: sent ? (opened < sent ? "A nudge on your next call helps" : "Every sent report was read") : "Shows once a report is sent" },
            { label: "Care revenue", value: moneyLabel(careMrr), sub: "a month, the work these reports prove" },
          ]} label="This month's reports" />
        )}
        {loaded && list.length === 0 && missing.length === 0 && (
          <EmptyState icon="file-text" title="No Care clients to report on yet"
            steps={[
              { title: "Put a client on Care", text: "Care starts from a signed proposal or the client's Billing. Their sites are then watched every day.", to: "/clients" },
              { title: "The report builds itself", text: "Early each month the uptime, updates, edit hours and traffic are collected and Claude writes the summary." },
              { title: "You read, tweak, approve", text: "Edit the words here, then approve it on Today. Only then is it mailed with a private link." },
            ]}>
            Each month every Care client gets a short report: how their site did, what was done and what's next.
          </EmptyState>
        )}
        {loaded && (list.length > 0 || missing.length > 0) && (
          <div className="pb-cols">
            <div className="pb-side">
              {missing.length > 0 && (
                <Card icon="clock" title="Not started" note={`${missing.length} client${missing.length === 1 ? "" : "s"}`} flush>
                  <p className="pb-hint" style={{ padding: "12px 18px 0" }}>On Care but no report for this month yet. They start by themselves in the first days of the month; Build now makes one straight away.</p>
                  <ul className="rp-missing-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>{missing.map((c) => <Missing key={c.businessId} c={c} onBuilt={load} />)}</ul>
                </Card>
              )}
              {list.length > 0 && <ul className="cr-board">{list.map((r) => <ReportCard key={r.id} r={r} onChanged={replace} />)}</ul>}
            </div>
            <div className="pb-side">
              <Card icon="list" title="This month" note={period ? periodLabel("monthly", period) : undefined}>
                <ul className="pb-rows">
                  <li><span>Not started</span><b>{missing.length}</b></li>
                  <li><span>Collecting numbers</span><b>{collecting}</b></li>
                  <li><span>Ready for your OK</span><b>{ready}</b></li>
                  <li><span>Sent</span><b>{sent}</b></li>
                </ul>
              </Card>
              <Card icon="info" title="What the client gets">
                <ul className="pb-rows">
                  <li><span>Uptime and site health</span></li>
                  <li><span>Updates and fixes done</span></li>
                  <li><span>Edit hours used of their allowance</span></li>
                  <li><span>Traffic, once Google is linked</span></li>
                  <li><span>One thing we suggest next</span></li>
                </ul>
                <p className="pb-hint">A mail with your summary and a private link to the full page. Revoke kills the link.</p>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
