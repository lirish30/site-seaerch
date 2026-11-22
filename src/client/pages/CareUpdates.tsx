import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, careApi } from "../api";
import { useOwnerClock } from "../billingData";
import { batchLabel, canMarkFine, lastFailedLabel, pageFacts, reviewLabel, riskLabel, runLabel, verdictLabel, whyLabel } from "../careUpdatesView";
import { latestOnly } from "../clientView";
import { incidentLine } from "../careView";
import Icon, { type IconName } from "../components/Icon";
import { Banner, Card, Chip, Empty, Note, PageHeader, Stat, Stats, type Tone } from "../components/ds";
import type { CareRunDetail, CareRunView, CareSiteView, CareUpdateView, CareUpdatesBoard } from "../../worker/care/views";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** A run's state as a chip tone and icon: ok green, changed amber, rolled back or failed red, the rest plain. */
const RUN_TONE: Record<CareRunView["status"], Tone> = { queued: "neutral", running: "info", ok: "positive", changed: "warning", rolled_back: "critical", failed: "critical", dropped: "neutral" };
const RUN_WORD: Record<CareRunView["status"], string> = { queued: "Waiting", running: "Updating now", ok: "All fine", changed: "A page changed", rolled_back: "Put back", failed: "Failed", dropped: "Skipped" };
const RUN_ICON: Record<CareRunView["status"], IconName> = { queued: "clock", running: "refresh", ok: "check", changed: "eye", rolled_back: "alert", failed: "alert", dropped: "ban" };

const riskTone = (u: CareUpdateView): Tone => (u.held ? "neutral" : u.risk === "security" ? "critical" : u.needsTick ? "warning" : u.risk === "major" ? "warning" : "outline");

/** One update as a table row: its name and kind, the versions, its risk in words, and a Hold and a Security switch. Switches use aria-disabled while the request runs, so they keep keyboard focus. */
function UpdateRow({ u, now, zone, onChanged }: { u: CareUpdateView; now: Date; zone: string; onChanged: (u: CareUpdateView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function flip(flags: { held?: boolean; security?: boolean }) {
    if (busy) return;
    setBusy(true); setError("");
    try { onChanged(await careApi.setUpdateFlag(u.id, flags)); }
    catch (e) { setError(sentence(e, "Couldn’t save that. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <tr>
      <td><span className="crx-next"><b>{u.name}</b><small className="crx-dim">{u.type === "core" ? "WordPress core" : u.type === "plugin" ? "Plugin" : "Theme"}</small></span></td>
      <td><span className="crx-ver">{u.fromVersion} → <b>{u.toVersion}</b></span></td>
      <td>
        <span className="crx-flags">
          <Chip tone={riskTone(u)} dot>{riskLabel(u, now, zone)}</Chip>
          {!u.rollbackable && <Chip tone="outline">can’t roll back</Chip>}
          {u.lastFailedAt && <Chip tone="warning">{lastFailedLabel(u, zone)}</Chip>}
        </span>
        {error && <p className="crx-err" role="alert">{error}</p>}
      </td>
      <td>
        <span className="crx-switches">
          <label className="switch sm">
            <input type="checkbox" role="switch" checked={u.held} aria-disabled={busy} aria-label={`Hold ${u.name}`} onChange={(e) => void flip({ held: e.target.checked })} />
            <i aria-hidden="true" /><span>{u.held ? "Held back" : "Hold"}</span>
          </label>
          <label className="switch sm">
            <input type="checkbox" role="switch" checked={u.security} aria-disabled={busy} aria-label={`${u.name} is a security fix`} onChange={(e) => void flip({ security: e.target.checked })} />
            <i aria-hidden="true" /><span>{u.security ? "Security fix" : "Security"}</span>
          </label>
        </span>
      </td>
    </tr>
  );
}

/** The red strip for a site's open update incident, with the button that closes it once dealt with. */
function IncidentStrip({ s, now, zone, onReload }: { s: CareSiteView; now: Date; zone: string; onReload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!s.openIncident) return null;
  const inc = s.openIncident;
  async function close() {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.closeIncident(inc.id); await onReload(); }
    catch (e) { setError(sentence(e, "Couldn’t close it. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="crx-incident" role="alert">
      <Icon name="alert" size={16} />
      <p><b>Open incident.</b> {incidentLine(inc, now, zone)}{error && <span className="crx-err"> {error}</span>}</p>
      <button type="button" className="btn sm" aria-disabled={busy} onClick={() => void close()}>{busy ? "Closing…" : "Close this incident"}</button>
    </div>
  );
}

function LastRun({ run }: { run: CareRunView | null }) {
  if (!run) return <div className="crx-site-foot"><Icon name="clock" size={14} /><span>No run on this site yet.</span></div>;
  return (
    <div className="crx-site-foot">
      <Icon name={RUN_ICON[run.status]} size={14} />
      <span>Last run {dayOf(run.createdAt)}: {runLabel(run)}</span>
      <Link to={`/care/runs/${encodeURIComponent(run.id)}`}>See the pages</Link>
    </div>
  );
}

/** One site that can take updates: its updates waiting in a table, an open incident on top, the last run under it. */
function SiteCard({ s, now, zone, onUpdate, onReload }: { s: CareSiteView; now: Date; zone: string; onUpdate: (siteId: string, u: CareUpdateView) => void; onReload: () => Promise<void> }) {
  const ticks = s.updates.filter((u) => u.needsTick && !u.held).length;
  return (
    <Card icon="globe" title={s.domain ?? "Site with no domain yet"} flush
      note={s.updates.length === 0 ? "Up to date" : `${plural(s.updates.length, "update")} waiting${ticks ? ` · ${ticks} need${ticks === 1 ? "s" : ""} your OK` : ""}`}
      action={s.group ? <Chip tone="outline">{s.group}</Chip> : undefined}>
      <IncidentStrip s={s} now={now} zone={zone} onReload={onReload} />
      {s.updates.length === 0
        ? <p className="crx-empty-row">Nothing waiting to be updated.</p>
        : (
          <div className="crx-upd-wrap">
            <table className="ds-table crx-upd-table">
              <thead><tr><th>Update</th><th>Version</th><th>Risk</th><th aria-label="Switches" /></tr></thead>
              <tbody>{s.updates.map((u) => <UpdateRow key={u.id} u={u} now={now} zone={zone} onChanged={(next) => onUpdate(s.siteId, next)} />)}</tbody>
            </table>
          </div>
        )}
      <LastRun run={s.lastRun} />
    </Card>
  );
}

/** The weekly updates board: this week's batch, per site the updates waiting (with their risk in words), the sites that can't update and why, and the button that starts the batch now. */
export default function CareUpdates() {
  const { tz } = useOwnerClock();
  const [board, setBoard] = useState<CareUpdatesBoard | null>(null);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await careApi.updates();
      if (guard.isLatest(ticket)) { setBoard(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  function replace(siteId: string, u: CareUpdateView) {
    setBoard((b) => b && { ...b, sites: b.sites.map((s) => (s.siteId === siteId ? { ...s, updates: s.updates.map((x) => (x.id === u.id ? u : x)) } : s)) });
  }
  async function start() {
    if (starting) return;
    setStarting(true); setError(""); setNote("");
    try {
      const r = await careApi.startBatch();
      setNote(`This week’s batch is started: ${r.queued} ${r.queued === 1 ? "site" : "sites"} queued. Approve it on Today before anything touches a site.`);
      await load();
    } catch (e) { setError(sentence(e, "Couldn’t start the batch. Try again.")); }
    finally { setStarting(false); }
  }

  const now = new Date();
  const sites = board?.sites ?? [];
  const updatable = sites.filter((s) => s.canUpdate);
  const blocked = sites.filter((s) => !s.canUpdate);
  const waiting = updatable.flatMap((s) => s.updates);
  const ticks = waiting.filter((u) => u.needsTick && !u.held).length;
  const security = waiting.filter((u) => u.security && !u.held).length;
  const held = waiting.filter((u) => u.held).length;
  const incidents = sites.filter((s) => s.openIncident);
  const batch = board?.batch ?? null;
  const running = batch && batch.status !== "done" && batch.status !== "cancelled";

  return (
    <div className="ds-page crx">
      <PageHeader
        title="Care updates"
        sub="The WordPress updates waiting on each Care site. Nothing changes on a site until you approve it on Today."
        actions={<>
          <button type="button" className="ds-icon-btn crx-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
          <Link className="btn" to="/care"><Icon name="shield" size={16} />Care board</Link>
          <Link className="btn" to="/care/reports"><Icon name="file-text" size={16} />Reports</Link>
          {board !== null && <button type="button" className="btn primary" aria-disabled={starting} onClick={() => void start()}><Icon name="zap" size={16} />{starting ? "Starting…" : "Start this week’s batch now"}</button>}
        </>}
      />
      <div className="ds-body">
        {failed && <Banner tone="critical" title="Couldn't load the updates" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>{board ? "What you see may be out of date." : "Check your connection and try again."}</Banner>}
        {board === null && !failed && <p className="crx-loading">Loading the updates…</p>}
        {note && <Banner tone="positive" title="Batch started">{note}</Banner>}
        {error && <Banner tone="critical" title="The batch didn't start">{error}</Banner>}
        {board !== null && (
          <>
            {incidents.length > 0 ? (
              <Banner tone="critical" title={incidents.length === 1 ? `An update went wrong on ${incidents[0].domain ?? "a site"}` : `Updates went wrong on ${plural(incidents.length, "site")}`}>
                {incidents.length === 1 && incidents[0].openIncident ? `${incidentLine(incidents[0].openIncident, now, tz)}. ` : ""}Check the site, then close the incident on its card below.
              </Banner>
            ) : running ? (
              <Banner tone="signal" icon="refresh" title={`This week’s batch is running: ${batchLabel(batch.status).toLowerCase()}`}>Each wave waits for your OK on Today before it touches a site.</Banner>
            ) : ticks > 0 ? (
              <Banner tone="warning" title={`${plural(ticks, "update")} ${ticks === 1 ? "needs" : "need"} your OK`}>Major updates wait a week, then need a tick. Hold any you are not sure about.</Banner>
            ) : null}

            {sites.length > 0 && (
              <Stats label="This week">
                <Stat icon="zap" label="This week’s batch" value={batch ? batchLabel(batch.status) : "Not started"} sub={batch ? `Started ${dayOf(batch.createdAt)}` : "Starts on its own each week, or press Start"} />
                <Stat icon="refresh" label="Updates waiting" value={waiting.length} sub={`across ${plural(updatable.length, "site")}${held ? ` · ${held} held` : ""}`} />
                <Stat icon="alert" label="Need your OK" value={ticks} sub={security ? `${security} security ${security === 1 ? "fix" : "fixes"} in the queue` : ticks ? "Major updates" : "Nothing to tick"} tone={ticks || security ? "warning" : "positive"} />
                <Stat icon="ban" label="Can’t take updates" value={blocked.length} sub={blocked.length ? "Fix their access first" : "Every site can update"} tone={blocked.length ? "warning" : undefined} />
              </Stats>
            )}

            {sites.length === 0 && (
              <div className="ds-card"><Empty icon="refresh" title="No site is on Care yet" action={<Link className="btn" to="/care"><Icon name="shield" size={16} />Go to the Care board</Link>}>
                Each week the WordPress updates waiting on every Care site show here, with their risk in words. A site appears once its client is on Care; it can take updates once it has SSH access, a path and WordPress.
              </Empty></div>
            )}

            {updatable.map((s) => <SiteCard key={s.siteId} s={s} now={now} zone={tz} onUpdate={replace} onReload={load} />)}

            {blocked.length > 0 && (
              <Card icon="ban" title="Sites that can’t take updates" note={plural(blocked.length, "site")} flush>
                {blocked.map((s) => (
                  <div key={s.siteId}>
                    <IncidentStrip s={s} now={now} zone={tz} onReload={load} />
                    <div className="crx-blocked-row">
                      <span className="ds-tile warning"><Icon name="key" size={14} /></span>
                      <div><b>{s.domain ?? "Site with no domain yet"}</b><small>{whyLabel(s.why)}</small></div>
                      {s.group && <Chip tone="outline">{s.group}</Chip>}
                      {s.lastRun && <Link className="btn sm" to={`/care/runs/${encodeURIComponent(s.lastRun.id)}`}>Last run</Link>}
                    </div>
                  </div>
                ))}
              </Card>
            )}
            {sites.length > 0 && <Note>Hold keeps an update out of every batch until you switch it off. Security marks it as a security fix: it goes in the next batch at once, even a major one.</Note>}
          </>
        )}
      </div>
    </div>
  );
}

function Picture({ src, kind }: { src: string | null; kind: "before" | "after" | "difference" }) {
  return (
    <figure className="crx-pic">
      {src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={kind} loading="lazy" /></a> : <div className="crx-nopic">No picture</div>}
      <figcaption>{kind}</figcaption>
    </figure>
  );
}

const verdictTone = (v: "ok" | "changed" | "broken"): Tone => (v === "broken" ? "critical" : v === "changed" ? "warning" : "positive");

/** One run: each checked page with its before, after and difference pictures side by side (stacked at phone width), its verdict and review, and "Looks fine" where it is waiting. */
export function CareRunPage() {
  const { id = "" } = useParams();
  const [run, setRun] = useState<CareRunDetail | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setRun(await careApi.run(id)); setFailed(""); }
    catch (e) { setFailed(e instanceof ApiError && e.status === 404 ? "This run doesn’t exist." : "Couldn’t load this run."); }
  }, [id]);
  useEffect(() => { setRun(null); void load(); }, [load]);
  async function fine(checkId: string) {
    if (busy) return;
    setBusy(checkId); setError("");
    try { await careApi.pageOk(checkId); await load(); }
    catch (e) { setError(sentence(e, "Couldn’t save that. Try again.")); }
    finally { setBusy(null); }
  }
  const look = run?.pages.filter((p) => canMarkFine(p.review)).length ?? 0;
  return (
    <div className="ds-page crx">
      <PageHeader
        crumbs={[{ label: "Care updates", to: "/care/updates" }, { label: "Update run" }]}
        title="Update run"
        chips={run ? <Chip tone={RUN_TONE[run.status]} dot>{RUN_WORD[run.status]}</Chip> : undefined}
        meta={run ? [
          { icon: "calendar", text: `Started ${dayOf(run.createdAt)}${run.finishedAt ? `, finished ${dayOf(run.finishedAt)}` : ""}` },
          { icon: "file-text", text: `${plural(run.pages.length, "page")} checked` },
          ...(run.backupFile ? [{ icon: "shield" as const, text: `Backup taken before updating: ${run.backupFile}` }] : []),
        ] : undefined}
        sub={run ? runLabel(run) : undefined}
        actions={<Link className="btn" to="/care/updates"><Icon name="chevron-left" size={16} />Care updates</Link>}
      />
      <div className="ds-body">
        {failed && <Banner tone="critical" title={failed} action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>} />}
        {run === null && !failed && <p className="crx-loading">Loading the run…</p>}
        {error && <Banner tone="critical" title={error} />}
        {run && look > 0 && <Banner tone="warning" icon="eye" title={`${plural(look, "page")} ${look === 1 ? "needs" : "need"} your look`}>Compare the before and after, then press Looks fine if it is.</Banner>}
        {run && run.pages.length === 0 && <div className="ds-card"><Empty icon="eye" title="No pages were checked in this run">The pages listed in the site's Care paths are photographed before and after each update. Add paths on the client's site to check more.</Empty></div>}
        {run && run.pages.map((p) => (
          <Card key={p.id} icon="file-text" title={p.path} note={pageFacts(p)} action={<Chip tone={verdictTone(p.verdict)} dot>{verdictLabel(p.verdict)}</Chip>}>
            <div className="crx-pics">
              <Picture src={p.pictures.before} kind="before" />
              <Picture src={p.pictures.after} kind="after" />
              <Picture src={p.pictures.diff} kind="difference" />
            </div>
            <div className="crx-review">
              <p><b>Review:</b> {reviewLabel(p.review)}</p>
              {canMarkFine(p.review) && <button type="button" className="btn primary sm" aria-disabled={busy !== null} onClick={() => void fine(p.id)}><Icon name="check" size={14} />{busy === p.id ? "Saving…" : "Looks fine"}</button>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
