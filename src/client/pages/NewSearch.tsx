import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Radar, Search } from "../types";
import { RADAR_INTERVALS, radarBodyFor, radarFollowUpNotice, startErrorText } from "../radar";

const TYPES = ["plumber", "electrician", "roofer", "HVAC", "dentist", "chiropractor", "restaurant", "landscaper", "auto repair", "law firm", "salon", "church"];

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState(""); const [type, setType] = useState("");
  const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<{ estUsd: number; spent: number; limit: number; ok: boolean } | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Search[]>([]);
  const [repeat, setRepeat] = useState(false); const [every, setEvery] = useState(30);
  const [recentErr, setRecentErr] = useState(""); const [estErr, setEstErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.get<Search[]>("/searches")
      .then((r) => { if (!cancelled) setRecent(r); })
      .catch(() => { if (!cancelled) setRecentErr("Couldn't load recent searches."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.get<typeof est>(`/searches/estimate?maxResults=${maxResults}`)
      .then((r) => { if (!cancelled) { setEst(r); setEstErr(""); } })
      .catch(() => { if (!cancelled) { setEst(null); setEstErr("Couldn't load the cost estimate."); } });
    return () => { cancelled = true; };
  }, [maxResults]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    let s: Search;
    try { s = await api.post<Search>("/searches", { location, businessType: type, maxResults }); }
    catch (x) { setErr(x instanceof ApiError ? startErrorText(x.status, x.message) : "Failed"); setBusy(false); return; }
    if (!repeat) { nav(`/searches/${s.id}`); return; }
    // The search above is the first run, so the radar's first run is due in `every` days (runNow stays false).
    let notice = "";
    try { await api.post<Radar>("/radar", radarBodyFor({ location: s.location, businessType: s.business_type, radiusKm: s.radius_km, maxResults: s.max_results }, every)); }
    catch (x) { notice = x instanceof ApiError ? radarFollowUpNotice(x.status, x.message) : radarFollowUpNotice(0, ""); }
    nav(`/searches/${s.id}`, notice ? { state: { notice } } : undefined);
  }

  return (
    <div className="grid2">
      <form className="card" onSubmit={submit}>
        <h2>New search</h2>
        <label htmlFor="loc">Location</label>
        <input id="loc" placeholder="Boise, ID" value={location} onChange={(e) => setLocation(e.target.value)} required />
        <label htmlFor="type">Business type</label>
        <input id="type" list="types" placeholder="plumber" value={type} onChange={(e) => setType(e.target.value)} required />
        <datalist id="types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        <label htmlFor="m">Max results</label>
        <input id="m" type="number" min={1} max={200} value={maxResults} onChange={(e) => setMax(Number(e.target.value))} />
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          Repeat this search every
          <select style={{ width: "auto" }} aria-label="Radar interval" value={every} disabled={!repeat} onChange={(e) => setEvery(Number(e.target.value))}>
            {RADAR_INTERVALS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          days (Radar)
        </label>
        {est && <p className="muted">Estimated cost: up to ${est.estUsd.toFixed(2)} · spent this month ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)}</p>}
        {estErr && <p className="error">{estErr}</p>}
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy || (est !== null && !est.ok)}>{busy ? "Starting…" : "Find businesses"}</button>
      </form>
      <div className="card">
        <h2>Recent searches</h2>
        {recentErr && <p className="error">{recentErr}</p>}
        <table><tbody>
          {recent.map((s) => (
            <tr key={s.id}>
              <td><Link to={`/searches/${s.id}`}>{s.business_type} in {s.location}</Link></td>
              <td className="muted">{s.processed_count}/{s.found_count}</td>
              <td><span className="badge">{s.status}</span></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
