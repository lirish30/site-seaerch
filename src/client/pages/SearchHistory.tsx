import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SearchSummary } from "../../worker/search-summary";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { Badge, LeadScore } from "../components/Score";
import { SPEND_LIMIT_REACHED, isSpendLimit } from "../spend";
import {
  barPercent, DEFAULT_HISTORY_FILTERS, failureReason, filterSearches, isImport, radarFor, radarLabel, runningLine, runState, scanLabel,
  searchTitle, startedLabel, STARTED_OPTIONS, STATE_LABEL, STATE_TONE, usd, type HistoryFilters,
} from "../searchView";
import type { Radar, Search } from "../types";
import { useNow } from "./SearchProgress";

const POLL_MS = 5000;

/** Starts the same search again (what Run again does on a failed or stopped row). */
export const rerun = (s: Search) => api.post<Search>("/searches", {
  location: s.location, businessType: s.business_type, radiusKm: s.radius_km ?? 15, maxResults: s.max_results, quickScan: s.quick_scan === 1,
});

/** Every past search, newest first: status, counts, hot leads, scan, estimated cost and the radar that re-runs it. Polls while one is running. */
export default function SearchHistory() {
  const nav = useNavigate();
  const [searches, setSearches] = useState<Search[] | null>(null);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [radars, setRadars] = useState<Radar[]>([]);
  const [err, setErr] = useState("");
  const [rerunErr, setRerunErr] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const [list, sum, rad] = await Promise.all([
        api.get<Search[]>("/searches"),
        api.get<SearchSummary>("/searches/summary").catch(() => null), // the counts and costs are extras; the list still shows without them
        api.get<Radar[]>("/radar").catch(() => null),
      ]);
      if (!alive.current) return;
      setSearches(list); setErr("");
      if (sum) setSummary(sum);
      if (rad) setRadars(rad);
    } catch (e) {
      if (alive.current) setErr(e instanceof ApiError && e.message ? e.message : "Couldn't load your searches.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const anyRunning = searches?.some((s) => s.status === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, load]);
  const now = useNow(anyRunning);

  const shown = useMemo(() => (searches ? filterSearches(searches, filters, new Date()) : []), [searches, filters]);
  const set = (p: Partial<HistoryFilters>) => setFilters((f) => ({ ...f, ...p }));
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_HISTORY_FILTERS);

  const retry = async (s: Search) => {
    if (busy.has(s.id)) return;
    setBusy((b) => new Set(b).add(s.id)); setRerunErr("");
    try {
      const created = await rerun(s);
      nav(`/searches/${created.id}`);
    } catch (e) {
      if (alive.current) setRerunErr(isSpendLimit(e) ? SPEND_LIMIT_REACHED : e instanceof ApiError && e.message ? e.message : "Couldn't start the search. Try again.");
    } finally {
      if (alive.current) setBusy((b) => { const n = new Set(b); n.delete(s.id); return n; });
    }
  };

  const totals = summary?.totals;
  const subtitle = !searches ? "Loading…"
    : totals ? `${totals.searches} ${totals.searches === 1 ? "search" : "searches"} · ${totals.found.toLocaleString("en-US")} businesses found · ${usd(totals.spentUsd)} spent all time`
    : `${searches.length} ${searches.length === 1 ? "search" : "searches"}`;

  return (
    <div className="sh-page">
      <header className="page-header">
        <div><h1>Search history</h1><p>{subtitle}</p></div>
        <div className="header-actions"><Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link></div>
      </header>
      <div className="page-body">
        <div className="table-tools sh-tools">
          <label className="search-box"><Icon name="search" size={14} />
            <input type="search" placeholder="Search type or town…" value={filters.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search your searches" />
          </label>
          <label className={`filter${filters.status !== "any" ? " on" : ""}`}><span>Status</span>
            <select value={filters.status} onChange={(e) => set({ status: e.target.value as HistoryFilters["status"] })} aria-label="Status">
              <option value="any">Any</option>{(["running", "done", "failed", "stopped"] as const).map((k) => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
            </select><Icon name="chevron-down" size={14} /></label>
          <label className={`filter${filters.scan !== "any" ? " on" : ""}`}><span>Scan</span>
            <select value={filters.scan} onChange={(e) => set({ scan: e.target.value as HistoryFilters["scan"] })} aria-label="Scan">
              <option value="any">Any</option><option value="quick">Quick</option><option value="full">Full</option>
            </select><Icon name="chevron-down" size={14} /></label>
          <label className={`filter${filters.started !== DEFAULT_HISTORY_FILTERS.started ? " on" : ""}`}><span>Started</span>
            <select value={filters.started} onChange={(e) => set({ started: e.target.value as HistoryFilters["started"] })} aria-label="Started">
              {STARTED_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select><Icon name="chevron-down" size={14} /></label>
          {filtered && <button type="button" className="ghost" onClick={() => setFilters(DEFAULT_HISTORY_FILTERS)}>Clear</button>}
        </div>
        {err && <p className="error" role="alert">{err} <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></p>}
        {rerunErr && <p className="error" role="alert">{rerunErr}</p>}
        {!searches ? (err ? null : <p className="muted" role="status">Loading…</p>)
          : searches.length === 0 ? (
            <div className="sh-empty"><h2>No searches yet</h2><p>Start one and it shows up here with its progress, hot leads and cost.</p>
              <Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link></div>
          ) : (
            <div className="sh-scroll"><div className="sh-table" role="table" aria-label="Searches">
              <div className="sh-row sh-head" role="row">
                <span role="columnheader">Search</span><span role="columnheader">Status</span>
                <span role="columnheader" className="r">Found</span><span role="columnheader" className="r">Audited</span>
                <span role="columnheader">Hot leads</span><span role="columnheader">Scan</span>
                <span role="columnheader" className="r" title="Estimated from list prices">Cost</span><span role="columnheader" className="sh-radar">Radar</span><span role="columnheader" />
              </div>
              {shown.map((s) => {
                const state = runState(s), running = state === "running", ended = state === "failed" || state === "stopped";
                const item = summary?.items[s.id];
                const radar = isImport(s) ? null : radarFor(s, radars);
                const fetching = running && s.found_count === 0;
                const title = searchTitle(s);
                return (
                  <div key={s.id} className="sh-row" role="row">
                    <span role="cell" className="sh-search">
                      <Link to={`/searches/${s.id}`} className="sh-name">{title}</Link>
                      <span className="sh-sub">{isImport(s) ? startedLabel({ ...s, new_only: 0 }) : startedLabel(s)}</span>
                    </span>
                    <span role="cell" className="sh-status">
                      <span className="sh-status-top">
                        <Badge tone={STATE_TONE[state]} dot>{STATE_LABEL[state]}</Badge>
                        {running && <span className="sh-status-text">{runningLine(s, now)}</span>}
                      </span>
                      {running && <span className="sh-bar" role="progressbar" aria-label={`${title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fetching ? undefined : barPercent(s)}><i style={{ width: `${barPercent(s)}%` }} /></span>}
                      {ended && <span className={`sh-fail${state === "stopped" ? " stopped" : ""}`} title={s.error ?? undefined}>{failureReason(s)}</span>}
                    </span>
                    <span role="cell" className="r sh-num">{fetching ? "—" : s.found_count}</span>
                    <span role="cell" className="r sh-num">{fetching ? "—" : s.processed_count}</span>
                    <span role="cell">{item && item.hot > 0
                      ? <span aria-label={`${item.hot} hot ${item.hot === 1 ? "lead" : "leads"}`}><LeadScore score={item.hot} legend={String(item.hot)} tier="hot" /></span>
                      : <span className="sh-dash">—</span>}</span>
                    <span role="cell" className="sh-scan">{scanLabel(s)}</span>
                    <span role="cell" className="r"><span className="num-mono" title="Estimated from list prices">{item ? usd(item.costUsd) : "—"}</span></span>
                    <span role="cell" className="sh-radar">{radar ? <><Icon name="radar" size={13} /><span>{radarLabel(radar)}</span></> : <span className="sh-dash">—</span>}</span>
                    <span role="cell" className="sh-go">
                      {ended && !isImport(s)
                        ? <button type="button" className="sh-retry" disabled={busy.has(s.id)} aria-label={`Run ${title} again`} title="Run this search again" onClick={() => void retry(s)}><Icon name="refresh" size={15} /></button>
                        : <Icon name="chevron-right" size={14} />}
                    </span>
                  </div>
                );
              })}
              {shown.length === 0 && (
                <div className="sh-none" role="row">No searches match{filtered ? " these filters" : ""}. {filtered && <button type="button" className="link-btn" onClick={() => setFilters(DEFAULT_HISTORY_FILTERS)}>Clear filters</button>}</div>
              )}
            </div></div>
          )}
      </div>
    </div>
  );
}
