import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { RADAR_INTERVALS, radarLabel, relativeDay, runConfirmText, startErrorText } from "../radar";
import type { Radar as RadarT } from "../types";

export default function Radar() {
  const [radars, setRadars] = useState<RadarT[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A failed reload keeps whatever table is already on screen and just reports the problem inline.
  const load = useCallback(async () => {
    try { const r = await api.get<RadarT[]>("/radar"); if (alive.current) { setRadars(r); setErr(""); } }
    catch (e) { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load radars."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); on ? n.add(id) : n.delete(id); return n; }); };
  async function act(id: string, fn: () => Promise<unknown>) {
    if (alive.current) setErr("");
    mark(id, true);
    try { await fn(); }
    catch (x) { if (alive.current) setErr(x instanceof ApiError ? startErrorText(x.status, x.message) : "Failed"); }
    await load(); mark(id, false);
  }
  const toggle = (r: RadarT) => act(r.id, () => api.patch(`/radar/${r.id}`, { enabled: !r.enabled }));
  const changeInterval = (r: RadarT, intervalDays: number) => act(r.id, () => api.patch(`/radar/${r.id}`, { intervalDays }));
  async function runNow(r: RadarT) {
    let estUsd: number;
    try { estUsd = (await api.get<{ estUsd: number }>(`/searches/estimate?maxResults=${r.max_results}`)).estUsd; }
    catch { if (alive.current) setErr("Couldn't load the cost estimate, so nothing was run."); return; }
    if (!confirm(runConfirmText(estUsd, r))) return;
    await act(r.id, () => api.post(`/radar/${r.id}/run`));
  }
  async function remove(r: RadarT) {
    if (!confirm(`Delete the radar for ${r.business_type} in ${r.location}? Past searches and leads stay.`)) return;
    await act(r.id, () => api.del(`/radar/${r.id}`));
  }

  return (
    <div>
      <h2>Radar</h2>
      <p className="muted">Saved searches that re-run on their own and surface new prospects. Each run spends like a normal search and obeys your monthly limit.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {!radars ? (err ? null : <p>Loading…</p>) : radars.length === 0 ? (
        <div className="card"><p>No radars yet. Tick “Repeat this search” on the <Link to="/">New search</Link> page to create one.</p></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Market</th><th>Every</th><th>On</th><th>Next run</th><th>Last run</th><th>New leads</th><th></th></tr></thead>
          <tbody>
            {radars.map((r) => {
              const isBusy = busy.has(r.id);
              return (
                <tr key={r.id}>
                  <td>{r.business_type} in {r.location}
                    {r.last_error && <div className="error">⚠ {r.last_error}</div>}</td>
                  <td>
                    <select style={{ width: "auto" }} aria-label={radarLabel("Repeat interval", r)} value={r.interval_days} disabled={isBusy}
                      onChange={(e) => changeInterval(r, Number(e.target.value))}>
                      {(RADAR_INTERVALS.includes(r.interval_days) ? RADAR_INTERVALS : [...RADAR_INTERVALS, r.interval_days].sort((a, b) => a - b))
                        .map((d) => <option key={d} value={d}>{d} days</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" style={{ width: "auto" }} aria-label={radarLabel("Radar enabled", r)} checked={!!r.enabled} disabled={isBusy} onChange={() => toggle(r)} /></td>
                  <td className="muted" title={r.next_run_at}>{r.enabled ? relativeDay(r.next_run_at) : "paused"}</td>
                  <td className="muted" title={r.last_run_at ?? ""}>{relativeDay(r.last_run_at)}</td>
                  <td>{r.last_search_id
                    ? <Link to={`/searches/${r.last_search_id}`}>{r.newLeadCount} new{r.lastSearchStatus === "running" ? " so far" : ""}</Link>
                    : <span className="muted">—</span>}</td>
                  <td><div className="row">
                    <button aria-label={radarLabel("Run now", r)} disabled={isBusy || !r.enabled} onClick={() => runNow(r)}>{isBusy ? "Working…" : "Run now"}</button>
                    <button aria-label={radarLabel("Delete", r)} disabled={isBusy} onClick={() => remove(r)}>Delete</button>
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
