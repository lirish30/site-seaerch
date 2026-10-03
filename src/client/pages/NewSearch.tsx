import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Search } from "../types";

const TYPES = ["plumber", "electrician", "roofer", "HVAC", "dentist", "chiropractor", "restaurant", "landscaper", "auto repair", "law firm", "salon", "church"];

export default function NewSearch() {
  const nav = useNavigate();
  const [location, setLocation] = useState(""); const [type, setType] = useState("");
  const [radiusKm, setRadius] = useState(15); const [maxResults, setMax] = useState(50);
  const [est, setEst] = useState<{ estUsd: number; spent: number; limit: number; ok: boolean } | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Search[]>([]);

  useEffect(() => { api.get<Search[]>("/searches").then(setRecent); }, []);
  useEffect(() => { api.get<typeof est>(`/searches/estimate?maxResults=${maxResults}`).then(setEst); }, [maxResults]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try { const s = await api.post<Search>("/searches", { location, businessType: type, radiusKm, maxResults }); nav(`/searches/${s.id}`); }
    catch (x) { setErr(x instanceof ApiError ? (x.status === 402 ? "This search would go over your monthly spend limit." : x.message) : "Failed"); setBusy(false); }
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
        <div className="row">
          <div style={{ flex: 1 }}><label htmlFor="r">Radius (km)</label><input id="r" type="number" min={1} max={100} value={radiusKm} onChange={(e) => setRadius(Number(e.target.value))} /></div>
          <div style={{ flex: 1 }}><label htmlFor="m">Max results</label><input id="m" type="number" min={1} max={200} value={maxResults} onChange={(e) => setMax(Number(e.target.value))} /></div>
        </div>
        {est && <p className="muted">Estimated cost: up to ${est.estUsd.toFixed(2)} · spent this month ${est.spent.toFixed(2)} of ${est.limit.toFixed(2)}</p>}
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy || (est !== null && !est.ok)}>{busy ? "Starting…" : "Find businesses"}</button>
      </form>
      <div className="card">
        <h2>Recent searches</h2>
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
