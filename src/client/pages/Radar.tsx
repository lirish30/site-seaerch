import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { RADAR_INTERVALS, relativeDay, startErrorText } from "../radar";
import type { Radar as RadarT } from "../types";

export default function Radar() {
  const [radars, setRadars] = useState<RadarT[] | null>(null);
  const [err, setErr] = useState(""); const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRadars(await api.get<RadarT[]>("/radar")); setLoadErr(""); }
    catch (e) { setLoadErr(e instanceof ApiError ? e.message : "Couldn't load radars."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setErr(""); setBusy(id);
    try { await fn(); }
    catch (x) { setErr(x instanceof ApiError ? startErrorText(x.status, x.message) : "Failed"); }
    await load(); setBusy(null);
  }
  const toggle = (r: RadarT) => act(r.id, () => api.patch(`/radar/${r.id}`, { enabled: !r.enabled }));
  const setInterval_ = (r: RadarT, intervalDays: number) => act(r.id, () => api.patch(`/radar/${r.id}`, { intervalDays }));
  const runNow = (r: RadarT) => act(r.id, () => api.post(`/radar/${r.id}/run`));
  const remove = (r: RadarT) => {
    if (!confirm(`Delete the radar for ${r.business_type} in ${r.location}? Past searches and leads stay.`)) return;
    return act(r.id, () => api.del(`/radar/${r.id}`));
  };

  return (
    <div>
      <h2>Radar</h2>
      <p className="muted">Saved searches that re-run on their own and surface new prospects. Each run spends like a normal search and obeys your monthly limit.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {loadErr ? <p className="error">{loadErr}</p> : !radars ? <p>Loading…</p> : radars.length === 0 ? (
        <div className="card"><p>No radars yet. Tick “Repeat this search” on the <Link to="/">New search</Link> page to create one.</p></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Market</th><th>Every</th><th>On</th><th>Next run</th><th>Last run</th><th>New leads</th><th></th></tr></thead>
          <tbody>
            {radars.map((r) => (
              <tr key={r.id}>
                <td>{r.business_type} in {r.location}
                  {r.last_error && <div className="error">⚠ {r.last_error}</div>}</td>
                <td>
                  <select style={{ width: "auto" }} aria-label="Repeat interval" value={r.interval_days} disabled={busy === r.id}
                    onChange={(e) => setInterval_(r, Number(e.target.value))}>
                    {(RADAR_INTERVALS.includes(r.interval_days) ? RADAR_INTERVALS : [...RADAR_INTERVALS, r.interval_days].sort((a, b) => a - b))
                      .map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </td>
                <td><input type="checkbox" style={{ width: "auto" }} aria-label={`Radar enabled for ${r.location}`} checked={!!r.enabled} disabled={busy === r.id} onChange={() => toggle(r)} /></td>
                <td className="muted" title={r.next_run_at}>{r.enabled ? relativeDay(r.next_run_at) : "paused"}</td>
                <td className="muted" title={r.last_run_at ?? ""}>{relativeDay(r.last_run_at)}</td>
                <td>{r.last_search_id
                  ? <Link to={`/searches/${r.last_search_id}`}>{r.newLeadCount} new{r.lastSearchStatus === "running" ? " so far" : ""}</Link>
                  : <span className="muted">—</span>}</td>
                <td><div className="row">
                  <button disabled={busy === r.id || !r.enabled} onClick={() => runNow(r)}>{busy === r.id ? "Working…" : "Run now"}</button>
                  <button disabled={busy === r.id} onClick={() => remove(r)}>Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
