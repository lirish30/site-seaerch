import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { estimateNewSearchSeconds, formatEta } from "../eta";
import { searchFinished } from "../poll";
import type { Radar, Search } from "../types";
import { RADAR_INTERVALS, radarBodyFor, radarFollowUpNotice } from "../radar";
import BusinessTypePicker from "./BusinessTypePicker";
import SearchProgress from "./SearchProgress";

const RESULT_PRESETS = [25, 50, 100, 200];
const RECENT_POLL_MS = 5000;
// inFlightUsd: estimated cost of searches still running, already counted in `ok` by the server.
type Estimate = { estUsd: number; inFlightUsd?: number; spent: number; limit: number; ok: boolean };

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState("");
  const [recent, setRecent] = useState<Search[]>([]);
  const [repeat, setRepeat] = useState(false); const [every, setEvery] = useState(30);
  const [quickScan, setQuickScan] = useState(true);
  const [recentErr, setRecentErr] = useState(""); const [estErr, setEstErr] = useState("");

  const loadRecent = useCallback(async () => {
    try { setRecent(await api.get<Search[]>("/searches")); setRecentErr(""); }
    catch { setRecentErr("Couldn't load recent searches."); }
  }, []);
  useEffect(() => { loadRecent(); }, [loadRecent]);
  const anyRunning = recent.some((s) => !searchFinished(s));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(loadRecent, RECENT_POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, loadRecent]);

  useEffect(() => {
    let cancelled = false;
    api.get<Estimate>(`/searches/estimate?maxResults=${maxResults}`)
      .then((r) => { if (!cancelled) { setEst(r); setEstErr(""); } })
      .catch(() => { if (!cancelled) { setEst(null); setEstErr("Couldn't load the cost estimate."); } });
    return () => { cancelled = true; };
  }, [maxResults]);

  const count = types.length;
  const totalUsd = est ? est.estUsd * count : 0;
  const inFlight = est?.inFlightUsd ?? 0;
  const overLimit = est !== null && est.spent + inFlight + totalUsd > est.limit;
  const canSubmit = !busy && count > 0 && location.trim().length >= 2 && !overLimit;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setStarted(""); setBusy(true);
    const ok: Search[] = []; const failed: string[] = [];
    let limitHit = false;
    for (const t of types) {
      if (limitHit) { failed.push(`${t} (spend limit)`); continue; }
      try { ok.push(await api.post<Search>("/searches", { location, businessType: t, maxResults, quickScan })); }
      catch (x) {
        if (x instanceof ApiError && x.status === 402) limitHit = true;
        failed.push(x instanceof ApiError && x.status !== 402 ? `${t} (${x.message})` : t);
      }
    }
    // Radar: each search just started is that market's first run, so its radar's first run is due in `every` days (runNow stays false).
    let notice = "";
    if (repeat) {
      for (const s of ok) {
        try { await api.post<Radar>("/radar", radarBodyFor({ location: s.location, businessType: s.business_type, radiusKm: s.radius_km, maxResults: s.max_results }, every)); }
        catch (x) { notice = radarFollowUpNotice(x instanceof ApiError ? x.message : ""); }
      }
    }
    setBusy(false);
    if (ok.length === 1 && failed.length === 0) { nav(`/searches/${ok[0].id}`, notice ? { state: { notice } } : undefined); return; }
    const errText = failed.length ? `Couldn't start: ${failed.join(", ")}.${limitHit ? " This would go over your monthly spend limit." : ""}` : "";
    if (errText || notice) setErr([errText, notice].filter(Boolean).join(" "));
    if (ok.length) {
      setStarted(`Started ${ok.length} search${ok.length === 1 ? "" : "es"}. Progress updates below.`);
      setTypes(failed.length ? types.filter((t) => failed.some((f) => f.startsWith(t))) : []);
      loadRecent();
    }
  }

  const eta = count > 0 ? formatEta(estimateNewSearchSeconds(maxResults)) : "";
  return (
    <div className="new-layout">
      <form className="card new-form" onSubmit={submit}>
        <h2>New search</h2>
        <div className="field-row">
          <div className="field">
            <label htmlFor="loc">Location</label>
            <input id="loc" placeholder="Boise, ID" value={location} onChange={(e) => setLocation(e.target.value)} required />
          </div>
          <div className="field">
            <label id="max-label">Max results per type</label>
            <div className="segmented" role="group" aria-labelledby="max-label">
              {RESULT_PRESETS.map((n) => (
                <button type="button" key={n} className={maxResults === n ? "on" : ""} aria-pressed={maxResults === n} onClick={() => setMax(n)}>{n}</button>
              ))}
              <input type="number" aria-label="Custom max results" placeholder="Custom" min={1} max={200}
                value={RESULT_PRESETS.includes(maxResults) ? "" : maxResults}
                onChange={(e) => { const n = Number(e.target.value); if (n >= 1) setMax(Math.min(200, n)); }} />
            </div>
            {est && <p className="muted small" style={{ margin: "6px 0 0" }}>
              {maxResults} results ≈ ${est.estUsd.toFixed(2)} per type (about ${(est.estUsd / maxResults).toFixed(3)} a lead for the browser check, AI review and draft)
            </p>}
          </div>
        </div>

        <label>Business types <span className="muted">· pick as many as you like</span></label>
        <BusinessTypePicker selected={types} onChange={setTypes} />

        <div style={{ marginTop: 12 }}>
          <label className="check">
            <input type="checkbox" checked={quickScan} onChange={(e) => setQuickScan(e.target.checked)} />
            Quick scan first (cheaper)
          </label>
          <p className="muted small" style={{ margin: "4px 0 0 26px" }}>
            Crawls and scores each business only. Screenshots, PageSpeed, the AI review and the draft wait until you run a full scan on the good ones from the Promising page.
            {repeat && quickScan ? " Repeats (Radar) always run full scans." : ""}
          </p>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <label className="check">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            Repeat {count > 1 ? "these searches" : "this search"} (Radar)
          </label>
          <label htmlFor="every" style={{ fontWeight: 400, margin: 0 }}>every</label>
          <select id="every" style={{ width: "auto" }} value={every} disabled={!repeat} onChange={(e) => setEvery(Number(e.target.value))}>
            {RADAR_INTERVALS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span>days</span>
        </div>

        {started && <p className="ok">{started}</p>}
        {err && <p className="error">{err}</p>}
        {estErr && <p className="error">{estErr}</p>}
        <div className="submit-bar">
          <div className="submit-info">
            <strong>{count === 0 ? "Select at least one type" : `${count} type${count === 1 ? "" : "s"} · up to ${count * maxResults} leads`}</strong>
            <span className="muted">
              {est && count > 0 && <>Est. cost up to ${totalUsd.toFixed(2)} · takes {eta} · </>}
              {est && <>spent ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)} this month{inFlight ? ` + $${inFlight.toFixed(2)} in searches still running` : ""}</>}
            </span>
            {overLimit && <span className="error">This would go over your monthly spend limit.</span>}
          </div>
          <button className="primary big" disabled={!canSubmit}>
            {busy ? <><span className="spinner light" aria-hidden /> Starting…</> : count > 1 ? `Find businesses (${count})` : "Find businesses"}
          </button>
        </div>
      </form>

      <div className="card recent">
        <h2>Recent searches</h2>
        {recentErr && <p className="error">{recentErr}</p>}
        {recent.length === 0 && !recentErr && <p className="muted">No searches yet.</p>}
        <ul className="recent-list">
          {recent.map((s) => (
            <li key={s.id}>
              <div className="row between">
                <Link to={`/searches/${s.id}`}>{s.business_type} in {s.location}</Link>
                <span className={`badge ${s.status}`}>{s.status}</span>
              </div>
              {s.status === "failed"
                ? <span className="muted">Failed{s.error ? `: ${s.error}` : ""}</span>
                : !searchFinished(s)
                  ? <SearchProgress search={s} compact />
                  : <span className="muted">{s.processed_count}/{s.found_count} audited</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
