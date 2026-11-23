import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { careApi } from "../api";
import { useOwnerClock } from "../billingData";
import { bandLabel, formatUptime, incidentLine, siteStateLabel, sortCare } from "../careView";
import { gradeChipLabel, latestOnly, moneyLabel } from "../clientView";
import { siteName } from "../components/client/CarePanel";
import Icon from "../components/Icon";
import { Avatar, Banner, Chip, Empty, Meter, Note, PageHeader, Seg, Stat, Stats, Timeline, type Tone } from "../components/ds";
import type { CareRow, SiteMonitoringView } from "../../worker/monitoring/fleet";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const bandTone = (r: CareRow): Tone => (!r.health.hasData ? "neutral" : r.health.band === "good" ? "positive" : r.health.band === "watch" ? "warning" : "critical");
const needsLook = (r: CareRow) => r.openIncidents.length > 0 || (r.health.hasData && r.health.band !== "good") || r.sites.some((s) => s.monitored && s.up === false);

/** A site's domain with its state in a word (Up, Slow, Down…); the colour only repeats the word. */
function SiteState({ site, named }: { site: SiteMonitoringView; named: boolean }) {
  const label = siteStateLabel(site);
  const tone: Tone = label === "Up" ? "positive" : label === "Slow" ? "warning" : label === "Down" ? "critical" : "outline";
  return <span className="crx-site" title={siteName(site)}><Chip tone={tone} dot>{label}</Chip>{named && <span className="crx-site-name">{siteName(site)}</span>}</span>;
}

/** The grade the owner set (A green, B plain, C amber), or the suggested one in an outline chip with a question mark. */
function Grade({ r }: { r: CareRow }) {
  const { letter, suggested } = gradeChipLabel(r.grade);
  if (suggested) return <Chip tone="outline" title={`Grade ${letter} suggested: you have not set one`}>{letter}?</Chip>;
  return <Chip tone={letter === "A" ? "positive" : letter === "C" ? "warning" : "neutral"} title={`Grade ${letter}`}>{letter}</Chip>;
}

type View = "all" | "look" | "care";

/** Care: every client with live Care or a site watched by hand, worst health first. A site shows its domain, never its address. */
export default function Care() {
  const { tz } = useOwnerClock();
  const navigate = useNavigate();
  const [rows, setRows] = useState<CareRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>("all");
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
  const all = rows ?? [];
  const onCare = all.filter((r) => r.careLabel !== null);
  const mrr = onCare.reduce((n, r) => n + r.mrrCents, 0);
  const measured = all.filter((r) => r.uptime30 !== null).sort((a, b) => (a.uptime30 ?? 0) - (b.uptime30 ?? 0));
  const lowest = measured[0];
  const incidents = all.flatMap((r) => r.openIncidents.map((i) => ({ i, r })));
  const look = all.filter(needsLook);
  const under80 = all.filter((r) => r.health.hasData && r.health.band !== "good").length;
  const shown = view === "look" ? look : view === "care" ? onCare : all;
  const worst = incidents.find(({ i }) => i.kind === "down") ?? incidents[0];
  const clientPath = (id: string) => `/clients/${encodeURIComponent(id)}`;

  return (
    <div className="ds-page crx">
      <PageHeader
        title="Care"
        sub={rows === null || rows.length === 0 ? "How each client's sites are doing, worst first." : `${plural(onCare.length, "client")} on Care · ${moneyLabel(mrr)} a month · worst health first. Test clients are left out.`}
        actions={<>
          <button type="button" className="ds-icon-btn crx-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
          <Link className="btn" to="/care/updates"><Icon name="zap" size={16} />Updates</Link>
          <Link className="btn" to="/care/reports"><Icon name="file-text" size={16} />Reports</Link>
        </>}
      />
      <div className="ds-body">
        {failed && <Banner tone="critical" title="Couldn't load the Care board" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{rows ? "What you see may be out of date." : "Check your connection and try again."}</Banner>}
        {rows === null && !failed && <p className="crx-loading">Loading the Care board…</p>}
        {rows !== null && rows.length === 0 && (
          <div className="ds-card"><Empty icon="shield" title="Nobody is on Care yet"
            action={<Link className="btn primary" to="/clients"><Icon name="users" size={16} />Go to clients</Link>}>
            Every looked-after site shows here: is it up, is anything broken, who needs you first. A client lands here when a signed proposal with a Care plan goes through, or when you switch monitoring on for a site from the client's page.
          </Empty></div>
        )}
        {rows !== null && rows.length > 0 && (
          <>
            <Stats label="Care at a glance">
              <Stat icon="shield" label="On Care" value={onCare.length} sub={`${moneyLabel(mrr)} a month${all.length > onCare.length ? ` · ${all.length - onCare.length} watched by hand` : ""}`} />
              <Stat icon="gauge" label="Lowest uptime, 30 days" value={lowest ? formatUptime(lowest.uptime30) : "None yet"} sub={lowest ? lowest.name : "Shows after the first checks"} tone={lowest && (lowest.uptime30 ?? 100) < 99 ? "warning" : lowest ? "positive" : undefined} />
              {incidents.length === 0 && look.length === 0 ? (
                <Stat icon="check" label="Incidents and health" value="All clear" sub={`No incidents · ${all.length === 1 ? "the client is" : `all ${all.length} clients are`} healthy`} tone="positive" />
              ) : <>
                <Stat icon="alert" label="Open incidents" value={incidents.length} sub={incidents.length ? "Fix these first" : "Nothing broken"} tone={incidents.length ? "critical" : "positive"} />
                <Stat icon="users" label="Need a look" value={look.length} sub={look.length ? (under80 ? `${plural(under80, "client")} under health 80` : "An incident or a site down") : "Every client healthy"} tone={look.length ? "warning" : "positive"} />
              </>}
            </Stats>

            {worst && (
              <Banner tone="critical" title={incidents.length > 1 ? `${plural(incidents.length, "incident")} open. Start with ${worst.r.name}` : `${worst.r.name}: ${worst.i.kind === "down" ? "the site is down" : "needs a look"}`}
                action={<Link className="btn sm" to={clientPath(worst.r.businessId)}>Open the client</Link>}>
                {worst.i.domain ? `${worst.i.domain}: ` : ""}{incidentLine(worst.i, now, tz)}.
              </Banner>
            )}

            {(look.length > 0 || onCare.length < all.length || view !== "all") && <div className="ds-toolbar">
              <Seg label="Show" value={view} onChange={setView} options={[
                { key: "all", label: "All", count: all.length },
                ...(look.length > 0 || view === "look" ? [{ key: "look" as const, label: "Need a look", count: look.length }] : []),
                ...(onCare.length < all.length || view === "care" ? [{ key: "care" as const, label: "On a Care plan", count: onCare.length }] : []),
              ]} />
            </div>}

            <div className="ds-table-wrap">
              <table className="ds-table crx-table">
                <thead><tr><th>Client</th><th className="crx-col-plan">Plan · grade</th><th>Health</th><th className="num">Uptime</th><th className="crx-col-sites">Site status</th><th>Incidents</th></tr></thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={6} className="crx-none">Nobody here: every client looks fine.</td></tr>}
                  {shown.map((r) => (
                    <tr key={r.businessId} data-href onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) navigate(clientPath(r.businessId)); }}>
                      <td>
                        <span className="ds-who"><Avatar name={r.name} />
                          <span><b><Link className="ds-row-link" to={clientPath(r.businessId)}>{r.name}</Link></b>
                            <small>{r.sites.length === 0 ? "No site to watch yet" : r.sites.length === 1 ? siteName(r.sites[0]) : `${r.sites.length} sites`}</small></span>
                        </span>
                      </td>
                      <td className="crx-col-plan"><span className="crx-inline crx-nowrap">{r.careLabel ? <Chip>{r.careLabel}</Chip> : <Chip tone="outline">Watched by hand</Chip>}<Grade r={r} /></span></td>
                      <td>
                        <span className="crx-health" title={r.health.reasons.join(". ") || undefined}>
                          <Meter value={r.health.hasData ? r.health.score : 0} max={100} tone={bandTone(r)} width={64} label={r.health.hasData ? `Health ${r.health.score} of 100, ${bandLabel(r.health.band).toLowerCase()}` : "No health score yet"} />
                          <b title={r.health.hasData ? undefined : "No checks yet"}>{r.health.hasData ? r.health.score : "–"}</b>
                        </span>
                        {r.health.reasons[0] && <small className="crx-reason">{r.health.reasons[0]}{r.health.reasons.length > 1 ? ` · ${r.health.reasons.length - 1} more` : ""}</small>}
                      </td>
                      <td className="num">{r.uptime30 === null ? <span className="crx-dim">–</span> : formatUptime(r.uptime30)}</td>
                      <td className="crx-col-sites">
                        {r.sites.length === 0 ? <span className="crx-dim">None</span> : <span className="crx-sites">{r.sites.map((s) => <SiteState key={s.siteId} site={s} named={r.sites.length > 1} />)}</span>}
                      </td>
                      <td>
                        {r.openIncidents.length === 0
                          ? <span className="crx-dim">None</span>
                          : <span className="crx-inc"><Chip tone="critical" dot>{r.openIncidents.length} open</Chip><small title={incidentLine(r.openIncidents[0], now, tz)}>{incidentLine(r.openIncidents[0], now, tz)}</small></span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>Health blends uptime, open incidents, payments and site access: hover a score to see what took points off. Grade is yours; a question mark is only a suggestion.</Note>
            {all.length <= 4 && (
              <section className="crx-what" aria-label="What Care does">
                <Link to="/care/updates" className="crx-what-card">
                  <span className="ds-tile info"><Icon name="refresh" size={16} /></span>
                  <span><b>Weekly updates</b><small>WordPress, plugins and themes, with a backup and before-and-after pictures. You approve each batch.</small></span>
                  <Icon name="chevron-right" size={14} className="ds-chev" />
                </Link>
                <Link to="/care/reports" className="crx-what-card">
                  <span className="ds-tile positive"><Icon name="file-text" size={16} /></span>
                  <span><b>Monthly report</b><small>Proof for the client that their site was looked after: uptime, updates, edit hours.</small></span>
                  <Icon name="chevron-right" size={14} className="ds-chev" />
                </Link>
                <div className="crx-what-card">
                  <span className="ds-tile signal"><Icon name="gauge" size={16} /></span>
                  <span><b>Checks all day</b><small>Each site is checked every few minutes; a site down or a domain running out opens an incident here.</small></span>
                </div>
              </section>
            )}

            {incidents.length > 0 && (
              <section className="crx-section" aria-label="Open incidents">
                <div className="ds-section-head"><h2>Open incidents</h2><span className="crx-dim">{plural(incidents.length, "incident")}</span></div>
                <Timeline groups={[{ label: "Open now", events: incidents.map(({ i, r }) => ({
                  key: i.id, icon: i.kind === "down" ? "alert" as const : i.kind === "update_failed" ? "refresh" as const : "globe" as const, tone: i.kind === "down" ? "critical" as const : "warning" as const,
                  title: `${r.name}${i.domain ? ` · ${i.domain}` : ""}`, sub: incidentLine(i, now, tz),
                  when: `Since ${new Date(i.openedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
                  to: clientPath(r.businessId),
                })) }]} />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
