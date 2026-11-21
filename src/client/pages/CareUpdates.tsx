import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, careApi } from "../api";
import { useOwnerClock } from "../billingData";
import { batchLabel, canMarkFine, pageFacts, reviewLabel, riskLabel, runLabel, verdictLabel, whyLabel } from "../careUpdatesView";
import { latestOnly } from "../clientView";
import { incidentLine } from "../careView";
import Icon from "../components/Icon";
import type { CareRunDetail, CareSiteView, CareUpdateView, CareUpdatesBoard } from "../../worker/care/views";

const sentence = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

/** One update: its name and versions, its risk in words, and a Hold and a Security switch. Switches use aria-disabled while the request runs, so they keep keyboard focus. */
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
    <li className="cu-update">
      <div className="cu-update-head">
        <b className="cu-update-name">{u.name}</b>
        <span className="muted small">{u.type} · {u.fromVersion} → {u.toVersion}</span>
        <span className={`badge2${u.risk === "security" ? " critical" : u.held ? "" : u.needsTick ? " warning" : ""}`}><i className="dot" aria-hidden="true" />{riskLabel(u, now, zone)}</span>
        {!u.rollbackable && <span className="badge2 outline">can’t roll back</span>}
      </div>
      <div className="cu-switches">
        <label className="switch cr-switch">
          <input type="checkbox" role="switch" checked={u.held} aria-disabled={busy} aria-label={`Hold ${u.name}`} onChange={(e) => void flip({ held: e.target.checked })} />
          <i aria-hidden="true" /><span>{u.held ? "Held back" : "Hold"}</span>
        </label>
        <label className="switch cr-switch">
          <input type="checkbox" role="switch" checked={u.security} aria-disabled={busy} aria-label={`${u.name} is a security fix`} onChange={(e) => void flip({ security: e.target.checked })} />
          <i aria-hidden="true" /><span>{u.security ? "Security fix" : "Security"}</span>
        </label>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  );
}

function SiteCard({ s, now, zone, onUpdate, onReload }: { s: CareSiteView; now: Date; zone: string; onUpdate: (siteId: string, u: CareUpdateView) => void; onReload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function close(id: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await careApi.closeIncident(id); await onReload(); }
    catch (e) { setError(sentence(e, "Couldn’t close it. Try again.")); }
    finally { setBusy(false); }
  }
  return (
    <li className="cl-card cu-site">
      <div className="cr-card-head">
        <h2 className="cr-name">{s.domain ?? "Site with no domain yet"}</h2>
        {s.group && <span className="badge2 outline">{s.group}</span>}
      </div>
      {!s.canUpdate && <p className="small cu-why">{whyLabel(s.why)}</p>}
      {s.openIncident && (
        <div className="cu-incident">
          <span className="badge2 critical"><i className="dot" aria-hidden="true" />Open</span>
          <span className="small">{incidentLine(s.openIncident, now, zone)}</span>
          <button type="button" className="btn" aria-disabled={busy} onClick={() => void close(s.openIncident!.id)}>Close this incident</button>
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {s.canUpdate && (s.updates.length === 0
        ? <p className="muted small">Nothing waiting to be updated.</p>
        : <ul className="cu-updates">{s.updates.map((u) => <UpdateRow key={u.id} u={u} now={now} zone={zone} onChanged={(next) => onUpdate(s.siteId, next)} />)}</ul>)}
      {s.lastRun && (
        <p className="small cu-lastrun">Last run: {runLabel(s.lastRun)}. <Link to={`/care/runs/${encodeURIComponent(s.lastRun.id)}`}>See the pages</Link></p>
      )}
    </li>
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
  const updatable = board?.sites.filter((s) => s.canUpdate) ?? [];
  const blocked = board?.sites.filter((s) => !s.canUpdate) ?? [];
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Care updates</h1>
          <p>The WordPress updates waiting on each site. Nothing is changed on a site until you approve it.</p>
        </div>
        <div className="header-actions">
          <Link className="btn" to="/care">Health</Link>
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the updates{board ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {board === null && !failed && <p className="muted">Loading…</p>}
        {board !== null && (
          <>
            <section className="cl-card cu-batch" aria-label="This week’s batch">
              <h2>This week’s batch</h2>
              <p className="small">{board.batch ? `Started. ${batchLabel(board.batch.status)}.` : "Not started yet this week."}</p>
              <button type="button" className="btn primary" aria-disabled={starting} onClick={() => void start()}>Start this week’s batch now</button>
              {note && <p className="small" role="status">{note}</p>}
              {error && <p className="error small" role="alert">{error}</p>}
            </section>
            {board.sites.length === 0 && <p className="muted">No site is on Care yet.</p>}
            {updatable.length > 0 && <ul className="cr-board">{updatable.map((s) => <SiteCard key={s.siteId} s={s} now={now} zone={tz} onUpdate={replace} onReload={load} />)}</ul>}
            {blocked.length > 0 && (
              <>
                <h2 className="cr-sub">Sites that can’t take updates</h2>
                <ul className="cr-board">{blocked.map((s) => <SiteCard key={s.siteId} s={s} now={now} zone={tz} onUpdate={replace} onReload={load} />)}</ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Picture({ src, kind }: { src: string | null; kind: "before" | "after" | "difference" }) {
  return (
    <figure className="cu-pic">
      {src ? <img src={src} alt={kind} loading="lazy" /> : <div className="cu-nopic muted small">No picture</div>}
      <figcaption className="small">{kind[0].toUpperCase() + kind.slice(1)}</figcaption>
    </figure>
  );
}

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
  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Update run</h1>
          {run && <p>{runLabel(run)}</p>}
        </div>
        <div className="header-actions"><Link className="btn" to="/care/updates">Care updates</Link></div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">{failed} <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {run === null && !failed && <p className="muted">Loading…</p>}
        {run && (
          <>
            {run.backupFile && <p className="small muted">Backup taken before updating: {run.backupFile}</p>}
            {error && <p className="error small" role="alert">{error}</p>}
            {run.pages.length === 0 && <p className="muted">No pages were checked in this run.</p>}
            <ul className="cr-board">
              {run.pages.map((p) => (
                <li key={p.id} className="cl-card cu-page">
                  <div className="cr-card-head">
                    <h2 className="cr-name">{p.path}</h2>
                    <span className={`badge2${p.verdict === "broken" ? " critical" : p.verdict === "changed" ? " warning" : " positive"}`}><i className="dot" aria-hidden="true" />{verdictLabel(p.verdict)}</span>
                  </div>
                  <p className="small muted">{pageFacts(p)}</p>
                  <div className="cu-pics">
                    <Picture src={p.pictures.before} kind="before" />
                    <Picture src={p.pictures.after} kind="after" />
                    <Picture src={p.pictures.diff} kind="difference" />
                  </div>
                  <p className="small cu-review"><b>Review:</b> {reviewLabel(p.review)}</p>
                  {canMarkFine(p.review) && <button type="button" className="btn" aria-disabled={busy !== null} onClick={() => void fine(p.id)}>Looks fine</button>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
