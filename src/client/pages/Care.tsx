import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { careApi } from "../api";
import { useOwnerClock } from "../billingData";
import { formatUptime, sortCare } from "../careView";
import { latestOnly } from "../clientView";
import { HealthChip, IncidentList, siteName, StateChip } from "../components/client/CarePanel";
import Icon from "../components/Icon";
import type { CareRow } from "../../worker/monitoring/fleet";

/** Care: one card per client with live Care or a site switched on by hand, worst health first. Plain words; a site shows its domain, never its address. */
export default function Care() {
  const { tz } = useOwnerClock();
  const [rows, setRows] = useState<CareRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await careApi.fleet();
      if (guard.isLatest(ticket)) { setRows(sortCare(next)); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const now = new Date();
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Care</h1>
          <p>How each client’s sites are doing, worst first. Test clients are left out.</p>
        </div>
        <div className="header-actions">
          <Link className="btn" to="/care/reports">Reports</Link>
          <Link className="btn" to="/care/updates">Updates</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the Care board{rows ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {rows === null && !failed && <p className="muted">Loading…</p>}
        {rows !== null && rows.length === 0 && <p className="muted">Nobody is on Care yet. A client shows here once they have a Care plan, or when you switch monitoring on for one of their sites.</p>}
        {rows !== null && rows.length > 0 && (
          <ul className="cr-board">
            {rows.map((r) => (
              <li key={r.businessId} className="cl-card cr-card">
                <div className="cr-card-head">
                  <h2 className="cr-name"><Link to={`/clients/${encodeURIComponent(r.businessId)}`}>{r.name}</Link></h2>
                  <HealthChip health={r.health} />
                </div>
                <p className="cr-meta small">
                  <span>{r.careLabel ?? <span className="muted">No Care plan</span>}</span>
                  <span>Uptime, 30 days: {formatUptime(r.uptime30)}</span>
                </p>
                <IncidentList incidents={r.openIncidents} now={now} zone={tz} />
                {r.sites.length === 0
                  ? <p className="muted small">No site to watch yet.</p>
                  : <ul className="cr-sitelist">{r.sites.map((s) => <li key={s.siteId}><span className="cr-site-name">{siteName(s)}</span><StateChip site={s} /></li>)}</ul>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
