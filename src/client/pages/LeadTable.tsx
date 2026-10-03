import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LeadRow } from "../types";
import { applyLeadFilters, defaultFilters, NOT_CRAWLED, OFFERS, platformOptions } from "../leadFilters";

type Key = "score" | "name" | "status";
const scoreClass = (s: number | null) => (s === null ? "low" : s >= 60 ? "high" : s >= 20 ? "mid" : "low");

export default function LeadTable({ rows }: { rows: LeadRow[] }) {
  const [sort, setSort] = useState<Key>("score");
  const [f, setF] = useState(defaultFilters);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const num = (v: string) => (v === "" ? null : Number(v));
  const platforms = useMemo(() => platformOptions(rows), [rows]);

  const view = useMemo(() => applyLeadFilters(rows, f)
    .sort((a, b) => sort === "score" ? (b.score ?? -1) - (a.score ?? -1)
      : sort === "name" ? a.business.name.localeCompare(b.business.name)
      : a.business.lead_status.localeCompare(b.business.lead_status)), [rows, sort, f]);

  return (
    <>
      <div className="row" style={{ margin: "12px 0" }}>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={f.hideSkipped} onChange={(e) => set({ hideSkipped: e.target.checked })} /> Hide skipped</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={f.emailOnly} onChange={(e) => set({ emailOnly: e.target.checked })} /> Has email</label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Min score <input type="number" min={0} max={100} style={{ width: 70 }} value={f.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} /></label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Min reviews <input type="number" min={0} style={{ width: 70 }} value={f.minReviews ?? ""} onChange={(e) => set({ minReviews: num(e.target.value) })} /></label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Max rating <input type="number" min={0} max={5} step={0.1} style={{ width: 70 }} value={f.maxRating ?? ""} onChange={(e) => set({ maxRating: num(e.target.value) })} /></label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Offer <select style={{ width: "auto" }} value={f.offer} onChange={(e) => set({ offer: e.target.value })}>
          <option value="any">any</option>{OFFERS.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
        <label className="row" style={{ margin: 0, fontWeight: 400 }}>Platform <select style={{ width: "auto" }} value={f.platform} onChange={(e) => set({ platform: e.target.value })}>
          <option value="any">any</option>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}<option value={NOT_CRAWLED}>not crawled</option></select></label>
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
                  <div className="muted">{r.business.website_url ?? "no website"}</div>
                  {r.platform && <div className="muted">{r.platform}</div>}</td>
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
