import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, careApi } from "../../api";
import { shortDate } from "../../billingView";
import { runLabel, whyLabel } from "../../careUpdatesView";
import { bandTone, formatUptime, healthChipText, incidentLine, siteStateLabel } from "../../careView";
import CareEditHours from "./CareEditHours";
import { Card, Chip, Empty, Score } from "../ds";
import Icon from "../Icon";
import type { CareSiteView } from "../../../worker/care/views";
import type { Health } from "../../../worker/clients/health";
import type { Site } from "../../../worker/db/sites";
import type { IncidentView, SiteMonitoringView } from "../../../worker/monitoring/fleet";

const BADGE = { ok: "positive", warn: "warning", bad: "critical" } as const;

/** The health score as a coloured chip that also says its band in words: "Health 82 · good", or "Health 82 · no checks yet · good". All text is a React text node. */
export function HealthChip({ health }: { health: Health }) {
  return <span className={`badge2 ${BADGE[bandTone(health.band)]}`}><i className="dot" aria-hidden="true" />{healthChipText(health)}</span>;
}

/** A site's state in a word or two, coloured: Up is green, Slow is amber, Down is red, the rest are plain. */
export function StateChip({ site }: { site: SiteMonitoringView }) {
  const label = siteStateLabel(site);
  const tone = label === "Up" ? " positive" : label === "Slow" ? " warning" : label === "Down" ? " critical" : "";
  return <span className={`badge2${tone}`}><i className="dot" />{label}</span>;
}

/** One site's domain, never its address; a site with no domain yet says so. */
export const siteName = (s: SiteMonitoringView): string => s.domain ?? "Site with no domain yet";

/** The incident lines of one client as plain sentences, each with its site's domain and whether it is still open. */
export function IncidentList({ incidents, now, zone, empty }: { incidents: IncidentView[]; now: Date; zone: string; empty?: string }) {
  if (incidents.length === 0) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <ul className="clx-incidents">
      {incidents.map((i) => (
        <li key={i.id}>
          <span className={`ds-tile ${i.closedAt === null ? "critical" : "neutral"}`}><Icon name={i.kind === "down" ? "zap" : i.kind === "update_failed" ? "refresh" : "calendar"} size={15} /></span>
          <span className="clx-setup-text"><b>{incidentLine(i, now, zone)}</b>{i.domain && <small>{i.domain}</small>}</span>
          <span className={`badge2${i.closedAt === null ? " critical" : ""}`}><i className="dot" aria-hidden="true" />{i.closedAt === null ? "Open" : "Closed"}</span>
        </li>
      ))}
    </ul>
  );
}

/** One site's block in the Sites card: its state, uptime, domain and certificate expiry, the monitoring switch, the last update run and the button that plans updates. */
function SiteRow({ site, view, care, onChanged }: { site: Site; view: SiteMonitoringView; care: CareSiteView | null; onChanged: () => Promise<void> }) {
  const [on, setOn] = useState(site.monitoring);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planned, setPlanned] = useState(false);
  const [planError, setPlanError] = useState("");
  useEffect(() => { setOn(site.monitoring); }, [site.monitoring]);
  async function plan() {
    if (planning) return;
    setPlanning(true); setPlanError(""); setPlanned(false);
    try { await careApi.runSite(site.id); setPlanned(true); await onChanged(); }
    catch (e) { setPlanError(e instanceof ApiError ? e.message : "Couldn’t plan the updates just now. Try again."); }
    finally { setPlanning(false); }
  }
  const viaCare = view.monitored && !site.monitoring;
  async function flip(next: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.setMonitoring(site.id, next); setOn(next); await onChanged(); }
    catch (e) { setOn(site.monitoring); setError(e instanceof ApiError ? e.message : "Couldn’t change monitoring just now. Try again."); }
    finally { setBusy(false); }
  }
  const name = siteName(view);
  const state = siteStateLabel(view);
  const tile = state === "Up" ? "positive" : state === "Slow" ? "warning" : state === "Down" ? "critical" : "neutral";
  const uptimeTone = view.uptime30 === null ? "" : view.uptime30 >= 99.5 ? " positive" : view.uptime30 >= 98 ? " warning" : " critical";
  return (
    <li className="clx-mon">
      <div className="clx-mon-head">
        <span className={`ds-tile ${tile}`}><Icon name="globe" size={16} /></span>
        <span className="clx-site-title"><b>{name}</b><small>{viaCare ? "Checked anyway, because this client has a Care plan" : on ? "Uptime watch switched on by hand" : "Uptime watch off"}</small></span>
        <span className="ds-grow" />
        <StateChip site={view} />
        <label className="switch" title={on ? "Switched on by hand" : "Not switched on by hand"}>
          <input type="checkbox" role="switch" checked={on} disabled={busy} aria-label={`Monitor ${name}`} onChange={(e) => void flip(e.target.checked)} />
          <i aria-hidden="true" />
        </label>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="clx-mon-stats">
        <div className="clx-mon-stat"><span>Uptime, 30 days</span><b className={uptimeTone}>{formatUptime(view.uptime30)}</b><small>{view.checks30 > 0 ? `from ${view.checks30.toLocaleString("en-US")} ${view.checks30 === 1 ? "check" : "checks"}` : "No checks yet"}</small></div>
        <div className="clx-mon-stat"><span>Domain</span><b>{view.domainExpiresOn ? shortDate(view.domainExpiresOn, true) : "Not known"}</b><small>{view.domainExpiresOn ? "Renews or expires" : "Expiry not read yet"}</small></div>
        <div className="clx-mon-stat"><span>Certificate</span><b>{site.certExpiresOn ? shortDate(site.certExpiresOn, true) : "Not known"}</b><small>{site.certExpiresOn ? "Expires" : "Not read yet"}</small></div>
      </div>
      <div className="clx-mon-run">
        <Icon name="refresh" size={15} />
        <span>
          {care?.lastRun
            ? <>Last update run: {runLabel(care.lastRun)}. <Link to={`/care/runs/${encodeURIComponent(care.lastRun.id)}`}>See the pages</Link></>
            : "No update run yet."}
          {care && !care.canUpdate && <><br /><span className="clx-muted">{whyLabel(care.why)}</span></>}
        </span>
        <button type="button" className="btn sm cu-run-btn" aria-disabled={planning} onClick={() => void plan()}>{planning ? "Planning…" : "Plan updates"}</button>
      </div>
      <p className="clx-help">Plan updates lines up this site’s plugin and theme updates. You approve them on Today before anything changes.</p>
      {planned && <p className="clx-saved" role="status"><Icon name="check" size={14} />Planned. Approve it on Today before anything is changed on the site.</p>}
      {planError && <p className="error small" role="alert">{planError}</p>}
    </li>
  );
}

/**
 * The Care tab of a client's page: on the left each site's state, uptime, domain and certificate expiry with its monitoring switch and update runs, then the last five incidents;
 * on the right the health score with its reasons, the edit hours and the last monthly report. The incident list is a separate read; if it fails the rest still shows.
 */
export default function CarePanel({ businessId, health, sites, zone, onChanged }: {
  businessId: string; health: Health; sites: { site: Site; monitoring: SiteMonitoringView }[]; zone: string; onChanged: () => Promise<void>;
}) {
  const [incidents, setIncidents] = useState<IncidentView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [board, setBoard] = useState<Map<string, CareSiteView>>(new Map());
  const load = useCallback(async () => {
    try { setIncidents(await careApi.incidents(businessId)); setFailed(false); }
    catch { setFailed(true); }
    // The updates board is a separate, optional read: without it the panel just shows no last run.
    try { setBoard(new Map((await careApi.updates()).sites.map((s) => [s.siteId, s]))); } catch { /* keep what we have */ }
  }, [businessId]);
  useEffect(() => { setIncidents(null); void load(); }, [load]);
  const changed = async () => { await Promise.all([onChanged(), load()]); };
  const now = new Date();
  const shown = (incidents ?? []).slice(0, 5);
  const open = shown.filter((i) => i.closedAt === null).length;
  const tone = bandTone(health.band) === "ok" ? "positive" : bandTone(health.band) === "warn" ? "warning" : "critical";
  return (
    <div className="clx-care-cols clx-care">
      <div className="ds-col">
        <Card icon="globe" title="Sites" note={`${sites.length} ${sites.length === 1 ? "site" : "sites"}`} flush>
          {sites.length === 0
            ? <Empty icon="globe" title="No site to watch yet">Add the client’s site on Sites & access. Its uptime, domain and certificate show here once it is watched.</Empty>
            : <ul className="clx-mon-list">{sites.map(({ site, monitoring }) => <SiteRow key={site.id} site={site} view={monitoring} care={board.get(site.id) ?? null} onChanged={changed} />)}</ul>}
        </Card>
        <Card icon="alert" title="Incidents" note={incidents === null ? undefined : open > 0 ? <Chip tone="critical" dot>{open} open</Chip> : "Last 5"} flush>
          {failed && <div className="ds-card-body"><p className="error small" role="alert">Couldn’t load the incidents. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p></div>}
          {!failed && incidents === null && <div className="ds-card-body"><p className="clx-muted">Loading…</p></div>}
          {incidents !== null && shown.length === 0 && (
            <div className="clx-calm"><span className="ds-tile positive"><Icon name="check" size={15} /></span><span className="clx-setup-text"><b>No incidents yet</b><small>Downtime, failed updates and expiring domains or certificates show here as they happen.</small></span></div>
          )}
          {shown.length > 0 && <IncidentList incidents={shown} now={now} zone={zone} />}
        </Card>
      </div>
      <div className="ds-col">
        <Card icon="gauge" title="Health" note={<HealthChip health={health} />}>
          <Score value={health.score} unit="of 100" meter={{ value: health.score, max: 100, tone }}
            reasons={health.reasons.length > 0 ? health.reasons.map((r) => ({ ok: false, text: r })) : [{ ok: true, text: "Nothing is pulling this score down." }]} />
        </Card>
        <CareEditHours businessId={businessId} />
      </div>
    </div>
  );
}
