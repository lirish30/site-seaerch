import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, trafficApi } from "../../api";
import { latestOnly, problemText } from "../../clientView";
import {
  PROFILE_CONNECT_PATH, PROFILE_HELP, accessLine, analyticsAccessLine, canClearLocation, canFind, canLink, canPull, canSaveLocation, canUnlink, foundLine, ga4IdProblem, hasLink, lastMonthOf, linkBody, linkedLines, locationBody, locationProblem,
  monthRows, needsDomain, profileNote, pullResult, showPanel, siteName, unlinkQuestion,
  type Candidates, type ClientTraffic, type PanelSite,
} from "../../trafficPanelView";
import type { AccessKey, AccessStatus } from "../../../worker/db/sites";
import { Card, Empty } from "../ds";
import Icon from "../Icon";

/** A sentence a job wants shown after it ran, and whether it is good news or a problem. */
type Said = { text: string; tone: "ok" | "error" };

/** One site: what is linked, the buttons that find, link, unlink and pull, and the months already pulled. Every text is a React text node. */
function SiteTraffic({ site, today, accessItems, busy, hasProfileScope, profileMissing, onRun }: {
  site: PanelSite; today: string; accessItems: { key: AccessKey; status: AccessStatus }[]; busy: boolean; hasProfileScope: boolean; profileMissing: string | null;
  onRun: (job: () => Promise<Said | void>, fail: string) => Promise<boolean>;
}) {
  const [found, setFound] = useState<Candidates | null>(null);
  const [gsc, setGsc] = useState("");
  const [ga4, setGa4] = useState("");
  const [ga4Typed, setGa4Typed] = useState("");
  const [location, setLocation] = useState("");
  useEffect(() => { setFound(null); setGsc(""); setGa4(""); setGa4Typed(""); setLocation(""); }, [site.siteId]);
  const lines = linkedLines(site);
  const rows = monthRows(site.months);
  const body = linkBody({ gsc, ga4, ga4Typed });
  const ga4Problem = ga4IdProblem(ga4Typed);
  const last = lastMonthOf(today);
  const analytics = analyticsAccessLine(accessItems);
  const name = siteName(site);
  const problem = locationProblem(location);
  const tiles: { label: string; value: string | null; icon: "search" | "trending" | "pin" }[] = [
    { label: "Search Console", value: site.gscProperty, icon: "search" },
    { label: "Analytics", value: site.ga4Property, icon: "trending" },
    { label: "Business Profile", value: site.gbpLocation, icon: "pin" },
  ];
  const nothing = lines.length === 0;
  return (
    <li className="clx-tp-site">
      <h3 className="clx-tp-name">{name}</h3>
      {needsDomain(site) && <p className="clx-help">Set the site’s domain first; a Google property can only be linked to a site with a domain.</p>}
      <div className="clx-tp-links" aria-label="What is linked">
        {tiles.map((t) => (
          <div key={t.label} className="clx-tp-link">
            <span className={`ds-tile ${t.value ? "positive" : "neutral"}`}><Icon name={t.value ? "check" : t.icon} size={15} /></span>
            <span><b>{t.label}</b><small className={t.value ? undefined : "none"}>{t.value ?? "Not linked"}</small></span>
          </div>
        ))}
      </div>
      {analytics && <p className="clx-help">{analytics}</p>}
      {site.lastError && <p className="error small" role="status">{site.lastError}</p>}
      <div className="ds-row">
        <button type="button" className={`btn${nothing ? " primary" : ""}`} disabled={!canFind(site, busy)} onClick={() => void onRun(async () => { setFound(await trafficApi.find(site.siteId)); setGsc(""); setGa4(""); setGa4Typed(""); }, "Couldn’t look for properties.")}><Icon name="search" size={16} />Find properties</button>
        <button type="button" className="btn" disabled={!canPull(site, busy, last)} onClick={() => void onRun(async () => pullResult(await trafficApi.pull(site.siteId, last!)), "Couldn’t pull last month.")}><Icon name="refresh" size={16} />Pull last month now</button>
        <span className="ds-grow" />
        {hasLink(site) && <button type="button" className="btn-plain clx-danger" disabled={!canUnlink(site, busy)} onClick={() => { if (window.confirm(unlinkQuestion(site))) void onRun(async () => { await trafficApi.unlink(site.siteId); setFound(null); }, "Couldn’t unlink."); }}>Unlink</button>}
      </div>
      {found && (
        <div className="clx-tp-box">
          <p className="ds-label">{foundLine(found)}</p>
          <div className="ds-form">
            {found.gsc.length > 0 && (
              <label className="deal-field" htmlFor={`tp-gsc-${site.siteId}`}><span>Search Console</span>
                <select id={`tp-gsc-${site.siteId}`} value={gsc} onChange={(e) => setGsc(e.target.value)}>
                  <option value="">Don’t link Search Console</option>
                  {found.gsc.map((g) => <option key={g.siteUrl} value={g.siteUrl}>{g.label}</option>)}
                </select>
              </label>
            )}
            {found.ga4.length > 0 && (
              <label className="deal-field" htmlFor={`tp-ga4-${site.siteId}`}><span>Analytics</span>
                <select id={`tp-ga4-${site.siteId}`} value={ga4} onChange={(e) => setGa4(e.target.value)}>
                  <option value="">Don’t link Analytics</option>
                  {found.ga4.map((p) => <option key={p.id} value={p.id}>{`${p.name} (${p.id})`}</option>)}
                </select>
              </label>
            )}
            <label className="deal-field" htmlFor={`tp-ga4-typed-${site.siteId}`}><span>Or paste a Google Analytics property id</span>
              <input id={`tp-ga4-typed-${site.siteId}`} type="text" inputMode="numeric" value={ga4Typed} placeholder="412345678" autoComplete="off" spellCheck={false} onChange={(e) => setGa4Typed(e.target.value)} />
              {ga4Problem && <small className="error" role="status">{ga4Problem}</small>}
            </label>
            <div className="ds-form-actions">
              <button type="button" className="btn primary" disabled={!canLink(body, busy)} onClick={() => void onRun(async () => { await trafficApi.link(site.siteId, body!); setFound(null); setGa4Typed(""); return { text: "Linked.", tone: "ok" as const }; }, "Couldn’t link.")}>Link</button>
              <button type="button" className="btn" onClick={() => setFound(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <details className="clx-tp-loc">
        <summary>Business Profile location{site.gbpLocation ? "" : " (not set)"}</summary>
        <div className="ds-form">
          <label className="deal-field wide" htmlFor={`tp-gbp-${site.siteId}`}><span>Location id</span>
            <input id={`tp-gbp-${site.siteId}`} type="text" value={location} placeholder="locations/1234567890" autoComplete="off" spellCheck={false} aria-describedby={`tp-gbp-help-${site.siteId}`} onChange={(e) => setLocation(e.target.value)} />
            <small id={`tp-gbp-help-${site.siteId}`}>{PROFILE_HELP}</small>
            {problem && <small className="error" role="status">{problem}</small>}
          </label>
          {profileMissing && <p className="clx-help wide">{profileMissing} <a href={PROFILE_CONNECT_PATH}>Add the Business Profile permission</a></p>}
          <div className="ds-form-actions">
            <button type="button" className="btn primary sm" disabled={!canSaveLocation(location, site, busy, hasProfileScope)} onClick={() => void onRun(async () => { await trafficApi.link(site.siteId, locationBody(location)!); setLocation(""); return { text: "Business Profile location saved.", tone: "ok" as const }; }, "Couldn’t save the location.")}>Save location</button>
            <button type="button" className="btn sm" disabled={!canClearLocation(site, busy)} onClick={() => void onRun(async () => { await trafficApi.link(site.siteId, { gbpLocation: null }); return { text: "Business Profile location cleared.", tone: "ok" as const }; }, "Couldn’t clear the location.")}>Clear location</button>
          </div>
        </div>
      </details>
      {rows.length > 0 && (
        <div className="clx-tp-table">
          <table className="ds-table">
            <thead><tr><th scope="col">Month</th><th scope="col">Status</th><th scope="col">What Google counted</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.period}>
                  <th scope="row">{r.label}</th>
                  <td><span className={`badge2 ${r.tone}`}><i className="dot" aria-hidden="true" />{r.statusWord}</span></td>
                  <td>{r.numbers || <span className="muted">Nothing counted</span>}{r.error && <p className="error small">{r.error}</p>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="clx-help clx-tp-cap">Counted by Google’s own month.</p>
        </div>
      )}
      {rows.length === 0 && hasLink(site) && <p className="clx-help">No month pulled yet. The daily pull reads last month from the 4th.</p>}
      {rows.length === 0 && !hasLink(site) && <p className="clx-help">Once a property is linked, clicks, visits and profile calls are pulled each month and show here, then go into the Care report.</p>}
    </li>
  );
}

/**
 * The Traffic panel on a client's page (Plan 16): the Google connection, and for each site what is linked in Search Console and Analytics, the buttons to find, link, unlink and pull, and the last six months pulled with their
 * status and the plain sentence for why one could not be read. Google is only read. Property ids are shown as they are: this page is the owner's alone.
 */
export default function TrafficPanel({ businessId, clientName, today, access }: {
  businessId: string; clientName: string; today: string; access: Record<string, { key: AccessKey; status: AccessStatus }[]>;
}) {
  const [data, setData] = useState<ClientTraffic | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await trafficApi.get(businessId);
      if (guard.isLatest(ticket)) { setData(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [businessId, guard]);
  useEffect(() => { setData(null); setFailed(false); setSaid(null); setError(""); void load(); return () => guard.cancel(); }, [load, guard]);

  /** Runs one change and reloads; true when it worked. A result it returns is shown, as a problem when it is one. */
  async function run(job: () => Promise<Said | void>, fail: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setSaid(null); setError("");
    try { const r = await job(); if (r) setSaid(r); await load(); return true; }
    catch (e) { setError(e instanceof ApiError ? problemText(e, fail) : fail); return false; }
    finally { setBusy(false); }
  }

  if (data === null) {
    return (
      <Card icon="trending" title="Traffic">
        {failed ? <p className="error small" role="alert">Couldn’t load traffic. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p> : <p className="muted small">Loading…</p>}
      </Card>
    );
  }
  if (!showPanel(data)) return <Card icon="trending" title="Traffic"><Empty icon="trending" title="No site to read traffic for">Search Console and Analytics numbers show here once this client has a site with a domain.</Empty></Card>;
  return (
    <Card icon="trending" title="Traffic" note={data.connected ? (data.email ?? "Google connected") : "Google not connected"}>
      <div className={`clx-tp-access${data.connected && data.hasScopes ? "" : " warn"}`}><Icon name={data.connected && data.hasScopes ? "info" : "alert"} size={15} /><span>{accessLine(data, clientName)}{!data.connected || !data.hasScopes ? <> <Link to="/settings/google">Google settings</Link></> : null}</span></div>
      <ul className="clx-tp-sites">
        {data.sites.map((s) => <SiteTraffic key={s.siteId} site={s} today={today} accessItems={access[s.siteId] ?? []} busy={busy} hasProfileScope={data.hasProfileScope} profileMissing={profileNote(data)} onRun={run} />)}
      </ul>
      {said && (said.tone === "ok" ? <p className="small" role="status">{said.text}</p> : <p className="error small" role="alert">{said.text}</p>)}
      {error && <p className="error small" role="alert">{error}</p>}
    </Card>
  );
}
