import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LeadRow } from "../types";

type Key = "score" | "name" | "status";
const scoreClass = (s: number | null) => (s === null ? "low" : s >= 60 ? "high" : s >= 20 ? "mid" : "low");

export default function LeadTable({ rows }: { rows: LeadRow[] }) {
  const [sort, setSort] = useState<Key>("score");
  const [hideSkipped, setHideSkipped] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [emailOnly, setEmailOnly] = useState(false);

  const view = useMemo(() => rows
    .filter((r) => !hideSkipped || r.business.lead_status !== "skip")
    .filter((r) => (r.score ?? 0) >= minScore)
    .filter((r) => !emailOnly || r.hasEmail)
    .sort((a, b) => sort === "score" ? (b.score ?? -1) - (a.score ?? -1)
      : sort === "name" ? a.business.name.localeCompare(b.business.name)
      : a.business.lead_status.localeCompare(b.business.lead_status)), [rows, sort, hideSkipped, minScore, emailOnly]);

  return (
    <>
      <div className="row" style={{ margin: "12px 0" }}>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} /> Hide skipped</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={emailOnly} onChange={(e) => setEmailOnly(e.target.checked)} /> Has email</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Min score <input type="number" min={0} max={100} style={{ width: 70 }} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
        <span className="muted">{view.length} of {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th onClick={() => setSort("name")}>Business</th>
            <th onClick={() => setSort("score")}>Score ▾</th>
            <th>Top finding</th><th>Best contact</th><th>Offer</th>
            <th onClick={() => setSort("status")}>Status</th>
          </tr></thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.business.id}>
                <td><Link to={`/leads/${r.business.id}`}>{r.business.name}</Link>
                  {r.business.last_error && <span title={r.business.last_error}> ⚠</span>}
                  <div className="muted">{r.business.website_url ?? "no website"}</div></td>
                <td><span className={`score ${scoreClass(r.score)}`}>{r.score ?? "…"}</span>{r.partial && <span className="badge" title="PageSpeed unavailable">partial</span>}</td>
                <td>{r.topFinding ?? <span className="muted">—</span>}</td>
                <td>{r.bestContact ?? <span className="muted">none</span>}</td>
                <td>{r.offer ?? "—"}</td>
                <td><span className="badge">{r.business.lead_status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
