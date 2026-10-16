import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { Badge } from "../components/Score";
import { pollDelay, searchFinished } from "../poll";
import { isSpendLimit, SPEND_LIMIT_REACHED } from "../spend";
import { metaLine, runState, searchTitle, STATE_LABEL, STATE_TONE } from "../searchView";
import type { LeadRow, Search } from "../types";
import { rerun } from "./SearchHistory";
import { FullScanNotice, ProgressCard } from "./ProgressCard";
import SearchResults from "./SearchResults";

type Data = { search: Search; leads: LeadRow[] };

/** One search: live progress while it runs (stages, counts, time left, Stop), then the same layout with its results once it is done, failed or stopped. */
export default function SearchDetail() {
  const { id } = useParams();
  const loc = useLocation(); const nav = useNavigate();
  // e.g. Radar couldn't be saved after NewSearch. Taken out of history state at once so reload/back don't bring it back.
  const [notice, setNotice] = useState<string | undefined>(() => (loc.state as { notice?: string } | null)?.notice);
  useEffect(() => { if ((loc.state as { notice?: string } | null)?.notice) nav(loc.pathname, { replace: true, state: null }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<Data | null>(null);
  const [refreshErr, setRefreshErr] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [busy, setBusy] = useState<"stop" | "rerun" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setData(null); setRefreshErr(""); setNotFound(false); setActionErr("");
    const load = async () => {
      try {
        const d = await api.get<Data>(`/searches/${id}`);
        if (cancelled) return;
        failures = 0;
        setData(d); setRefreshErr("");
        if (searchFinished(d.search)) return;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) { setNotFound(true); return; }
        failures++;
        setRefreshErr("Couldn't refresh, retrying…");
      }
      timer = setTimeout(load, pollDelay(failures));
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);

  // One-off refresh after a full scan starts. Separate from the poll above so it never starts a second timer.
  const refresh = async () => { try { setData(await api.get<Data>(`/searches/${id}`)); } catch { /* the poll reports load errors */ } };

  const stop = async () => {
    if (!data || busy || !window.confirm("Stop this search? Businesses already being audited may still finish, but no more will be started.")) return;
    setBusy("stop"); setActionErr("");
    try { await api.post(`/searches/${data.search.id}/stop`); await refresh(); }
    catch (e) { setActionErr(e instanceof ApiError && e.message ? (e.status === 409 ? "This search already finished." : e.message) : "Couldn't stop the search. Try again."); await refresh(); }
    finally { setBusy(null); }
  };
  const runAgain = async () => {
    if (!data || busy) return;
    setBusy("rerun"); setActionErr("");
    try { const s = await rerun(data.search); nav(`/searches/${s.id}`); }
    catch (e) { setActionErr(isSpendLimit(e) ? SPEND_LIMIT_REACHED : e instanceof ApiError && e.message ? e.message : "Couldn't start the search. Try again."); }
    finally { setBusy(null); }
  };

  if (notFound) {
    return (
      <div className="sp-page"><div className="page-body sp-body">
        <div className="sp-gone"><h2>Search not found</h2><p>It may have been removed.</p><Link to="/searches" className="btn">Back to Search history</Link></div>
      </div></div>
    );
  }
  if (!data) return <div className="sp-page"><div className="page-body sp-body">{refreshErr ? <p className="error" role="alert">{refreshErr}</p> : <p className="muted" role="status">Loading…</p>}</div></div>;

  const { search, leads } = data;
  const state = runState(search);
  const running = state === "running";
  const ended = state === "failed" || state === "stopped";
  const title = searchTitle(search);
  return (
    <div className="sp-page">
      <header className="page-header sp-header">
        <div>
          <Link to="/searches" className="sp-crumb">Search history</Link>
          <h1>{title}<Badge tone={STATE_TONE[state]} dot>{STATE_LABEL[state]}</Badge></h1>
          <p>{metaLine(search)}</p>
        </div>
        <div className="header-actions">
          {running && <button type="button" className="sp-stop" disabled={busy === "stop"} onClick={() => void stop()}><Icon name="x" size={16} />{busy === "stop" ? "Stopping…" : "Stop search"}</button>}
          <Link to="/leads" className="btn"><Icon name="users" size={16} />Open in All leads</Link>
        </div>
      </header>
      <div className="page-body sp-body">
        {notice && <div className="notice" role="status"><span>⚠ {notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice(undefined)}>✕</button></div>}
        {refreshErr && <p className="error" role="alert">{refreshErr}</p>}
        {actionErr && <p className="error" role="alert">{actionErr}</p>}
        <ProgressCard search={search} rows={leads} onRetry={ended ? () => void runAgain() : undefined} retrying={busy === "rerun"} />
        {search.quick_scan === 1 && (running || leads.length > 0) && <FullScanNotice rows={leads} running={running} onStarted={() => void refresh()} />}
        <div className="sp-results-head">
          <h2>{running ? "Results so far" : "Results"}</h2>
          <span>{running ? "New results appear as each site is audited" : leads.length ? `${leads.length} ${leads.length === 1 ? "business" : "businesses"}` : ""}</span>
        </div>
        <SearchResults rows={leads} running={running} />
      </div>
    </div>
  );
}
