import { useCallback, useEffect, useState } from "react";
import { ApiError, careApi } from "../../api";
import { shortDate } from "../../billingView";
import { bandTone, formatUptime, healthChipText, incidentLine, siteStateLabel } from "../../careView";
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
    <ul className="cr-incidents">
      {incidents.map((i) => (
        <li key={i.id}>
          <span className={`badge2${i.closedAt === null ? " critical" : ""}`}>{i.closedAt === null ? "Open" : "Closed"}</span>
          <span className="cr-incident-text">{incidentLine(i, now, zone)}</span>
          {i.domain && <span className="muted small">{i.domain}</span>}
        </li>
      ))}
    </ul>
  );
}

/** One site's row in the panel: its state, uptime, domain expiry and the switch. */
function SiteRow({ site, view, onChanged }: { site: Site; view: SiteMonitoringView; onChanged: () => Promise<void> }) {
  const [on, setOn] = useState(site.monitoring);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setOn(site.monitoring); }, [site.monitoring]);
  const viaCare = view.monitored && !site.monitoring;
  async function flip(next: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.setMonitoring(site.id, next); setOn(next); await onChanged(); }
    catch (e) { setOn(site.monitoring); setError(e instanceof ApiError ? e.message : "Couldn’t change monitoring just now. Try again."); }
    finally { setBusy(false); }
  }
  const name = siteName(view);
  return (
    <li className="cr-site">
      <div className="cr-site-head">
        <b className="cr-site-name">{name}</b>
        <StateChip site={view} />
      </div>
      <dl className="cr-facts">
        <dt>Uptime, 30 days</dt><dd>{formatUptime(view.uptime30)}{view.checks30 > 0 && <span className="muted small"> from {view.checks30} {view.checks30 === 1 ? "check" : "checks"}</span>}</dd>
        <dt>Domain</dt><dd>{view.domainExpiresOn ? `Expires ${shortDate(view.domainExpiresOn, true)}` : <span className="muted">Expiry not known yet</span>}</dd>
      </dl>
      <label className="switch cr-switch">
        <input type="checkbox" role="switch" checked={on} disabled={busy} aria-label={`Monitor ${name}`} onChange={(e) => void flip(e.target.checked)} />
        <i aria-hidden="true" />
        <span>{on ? "Switched on by hand" : "Not switched on by hand"}</span>
      </label>
      {viaCare && <p className="muted small cr-note">Checked anyway, because this client has a Care plan.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

/**
 * The Care panel on a client's page: the health chip with its reasons, each site's state, uptime and domain expiry with a monitoring switch,
 * and the last five incidents. The incident list is a separate read; if it fails the rest of the panel still shows.
 */
export default function CarePanel({ businessId, health, sites, zone, onChanged }: {
  businessId: string; health: Health; sites: { site: Site; monitoring: SiteMonitoringView }[]; zone: string; onChanged: () => Promise<void>;
}) {
  const [incidents, setIncidents] = useState<IncidentView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setIncidents(await careApi.incidents(businessId)); setFailed(false); }
    catch { setFailed(true); }
  }, [businessId]);
  useEffect(() => { setIncidents(null); void load(); }, [load]);
  const changed = async () => { await Promise.all([onChanged(), load()]); };
  return (
    <section className="cl-card cr-panel" aria-label="Care">
      <h2>Care</h2>
      <p className="cr-health"><HealthChip health={health} /></p>
      {health.reasons.length > 0
        ? <ul className="cr-reasons">{health.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        : <p className="muted small">Nothing is pulling this score down.</p>}

      <h3 className="cr-sub">Sites</h3>
      {sites.length === 0 && <p className="muted small">No site to watch yet.</p>}
      <ul className="cr-sites">
        {sites.map(({ site, monitoring }) => <SiteRow key={site.id} site={site} view={monitoring} onChanged={changed} />)}
      </ul>

      <h3 className="cr-sub">Last 5 incidents</h3>
      {failed && <p className="error small" role="alert">Couldn’t load the incidents. <button type="button" className="btn-plain" onClick={() => void load()}>Try again</button></p>}
      {!failed && incidents === null && <p className="muted small">Loading…</p>}
      {incidents !== null && <IncidentList incidents={incidents.slice(0, 5)} now={new Date()} zone={zone} empty="No incidents yet." />}
    </section>
  );
}
