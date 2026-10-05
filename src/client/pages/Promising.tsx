import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { FitChip } from "../components/FitChip";
import { FULL_SCAN_ADDS, fullScanErrorText, fullScanLabel, parseMinFit, promisingPath } from "../promising";
import { OFFER_LABEL, type LeadRow } from "../types";

const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

export default function Promising() {
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [minFitText, setMinFitText] = useState("");
  // The load error and the per-lead scan errors are separate, so reloading never wipes the result of a button the user pressed.
  const [loadErr, setLoadErr] = useState("");
  const [errs, setErrs] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const min = parseMinFit(minFitText);
  const minValue = min.ok ? min.value : null;
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!min.ok) return; // keep the list on screen while the box holds something invalid
    let cancelled = false; // ignore a response for a filter the user has already changed away from
    setLoadErr("");
    api.get<LeadRow[]>(promisingPath(minValue))
      .then((r) => { if (!cancelled && alive.current) setRows(r); })
      .catch((e) => { if (!cancelled && alive.current) setLoadErr(e instanceof ApiError ? e.message : "Couldn't load the queue."); });
    return () => { cancelled = true; };
  }, [min.ok, minValue, reloads]);

  const mark = (id: string, on: boolean) => { if (alive.current) setBusy((b) => { const n = new Set(b); on ? n.add(id) : n.delete(id); return n; }); };
  const fullScan = useCallback(async (r: LeadRow) => {
    const id = r.business.id;
    mark(id, true);
    if (alive.current) setErrs((e) => { const { [id]: _drop, ...rest } = e; return rest; });
    try {
      await api.post(`/leads/${id}/full-scan`);
      if (alive.current) setStarted((s) => new Set(s).add(id));
    } catch (x) {
      if (alive.current) setErrs((e) => ({ ...e, [id]: fullScanErrorText(x) }));
    }
    mark(id, false);
  }, []);

  return (
    <div>
      <div className="row between page-head">
        <h2>Promising</h2>
        <div className="row">
          <label className="check">Min fit <input type="number" min={0} max={100} className="num" aria-label="Minimum fit" placeholder="any"
            value={minFitText} onChange={(e) => setMinFitText(e.target.value)} /></label>
          <button onClick={() => setReloads((n) => n + 1)}>Refresh</button>
        </div>
      </div>
      <p className="muted">
        Leads that had a quick scan (crawl and score only), best fit first. A full scan adds: {FULL_SCAN_ADDS} Each one costs a little, so run it on the ones worth pursuing.
        Leads with no fit score are always listed, after the scored ones.
      </p>
      {!min.ok && <p className="error" role="alert">{min.error}</p>}
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!rows ? (loadErr ? null : <p>Loading…</p>) : rows.length === 0 ? (
        <div className="card"><p>No quick-scanned leads{minValue !== null ? " at that fit" : ""}. Start a search with “Quick scan first” ticked on the <Link to="/">New search</Link> page.</p></div>
      ) : (
        <div className="table-wrap"><table className="promising">
          <thead><tr><th>Business</th><th title="How well the business matches your best fit profile. — means no profile applies">Fit</th>
            <th title="Opportunity: higher is a better lead">Opp.</th><th>Top issue</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const id = r.business.id, isBusy = busy.has(id), isStarted = started.has(id);
              return (
                <tr key={id}>
                  <td className="cell-name">
                    <Link to={`/leads/${id}`} title={r.business.name}>{r.business.name}</Link>
                    <div className="sub" title={r.business.website_url ?? ""}>{host(r.business.website_url) || "no website"}</div>
                  </td>
                  <td><FitChip fit={r.fit} /></td>
                  <td><span className={`opp ${r.score === null ? "" : r.score >= 60 ? "hot" : r.score >= 25 ? "warm" : "cool"}`}>{r.score ?? "…"}</span></td>
                  <td><span className="clamp2" title={r.topFinding ?? ""}>{r.topFinding ?? <span className="muted">—</span>}</span>
                    {r.offer && <span className="sub">{OFFER_LABEL[r.offer] ?? r.offer}</span>}</td>
                  <td>
                    {isStarted
                      ? <span className="ok small" role="status">Full scan started. It leaves this list when it finishes (Refresh).</span>
                      : <button aria-label={fullScanLabel(r.business.name)} disabled={isBusy} onClick={() => fullScan(r)}>{isBusy ? "Starting…" : "Run full scan"}</button>}
                    {errs[id] && <div className="error small" role="alert">{errs[id]}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
