import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { estimateNewSearchSeconds, formatEta } from "../eta";
import { searchFinished } from "../poll";
import type { Search } from "../types";
import BusinessTypePicker from "./BusinessTypePicker";
import SearchProgress from "./SearchProgress";

const RESULT_PRESETS = [25, 50, 100, 200];
const RECENT_POLL_MS = 5000;
type Estimate = { estUsd: number; spent: number; limit: number; ok: boolean };

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<Estimate | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState("");
  const [recent, setRecent] = useState<Search[]>([]);
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
  const overLimit = est !== null && est.spent + totalUsd > est.limit;
  const canSubmit = !busy && count > 0 && location.trim().length >= 2 && !overLimit;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setStarted(""); setBusy(true);
    const ok: Search[] = []; const failed: string[] = [];
    let limitHit = false;
    for (const t of types) {
      if (limitHit) { failed.push(`${t} (spend limit)`); continue; }
      try { ok.push(await api.post<Search>("/searches", { location, businessType: t, maxResults })); }
      catch (x) {
        if (x instanceof ApiError && x.status === 402) limitHit = true;
        failed.push(x instanceof ApiError && x.status !== 402 ? `${t} (${x.message})` : t);
      }
    }
    setBusy(false);
    if (ok.length === 1 && failed.length === 0) { nav(`/searches/${ok[0].id}`); return; }
    if (failed.length) setErr(`Couldn't start: ${failed.join(", ")}.${limitHit ? " This would go over your monthly spend limit." : ""}`);
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

        {started && <p className="ok">{started}</p>}
        {err && <p className="error">{err}</p>}
        {estErr && <p className="error">{estErr}</p>}
        <div className="submit-bar">
          <div className="submit-info">
            <strong>{count === 0 ? "Select at least one type" : `${count} type${count === 1 ? "" : "s"} · up to ${count * maxResults} leads`}</strong>
            <span className="muted">
              {est && count > 0 && <>Est. cost up to ${totalUsd.toFixed(2)} · takes {eta} · </>}
              {est && <>spent ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)} this month</>}
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
