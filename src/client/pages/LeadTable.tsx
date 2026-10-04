import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MiniGauge } from "../components/HealthGauge";
import { NICHE_LABEL, OFFER_LABEL, type LeadRow } from "../types";

type Key = "name" | "health" | "score" | "niche" | "status" | "follow";
const PAGE = 50;
const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function value(r: LeadRow, k: Key): string | number {
  switch (k) {
    case "name": return r.business.name.toLowerCase();
    case "health": return r.health ?? 101; // unmeasured sorts last ascending
    case "score": return r.score ?? -1;
    case "niche": return r.niche ?? "~";
    case "status": return r.business.lead_status;
    case "follow": return r.business.follow_up_at ?? "9999";
  }
}

export default function LeadTable({ rows }: { rows: LeadRow[] }) {
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: "score", dir: -1 });
  const [hideSkipped, setHideSkipped] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [emailOnly, setEmailOnly] = useState(false);
  const [q, setQ] = useState("");
  const [niche, setNiche] = useState("");
  const [page, setPage] = useState(0);

  const niches = useMemo(() => [...new Set(rows.map((r) => r.niche).filter((x): x is string => !!x))].sort(), [rows]);
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => !hideSkipped || r.business.lead_status !== "skip")
      .filter((r) => (r.score ?? 0) >= minScore)
      .filter((r) => !emailOnly || r.hasEmail)
      .filter((r) => !niche || r.niche === niche)
      .filter((r) => !needle || `${r.business.name} ${r.business.website_url ?? ""} ${r.business.address ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const x = value(a, sort.k), y = value(b, sort.k);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.business.name.localeCompare(b.business.name);
      });
  }, [rows, sort, hideSkipped, minScore, emailOnly, q, niche]);
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const shown = view.slice(Math.min(page, pages - 1) * PAGE, Math.min(page, pages - 1) * PAGE + PAGE);

  const by = (k: Key, firstDir: 1 | -1 = 1) => () => { setPage(0); setSort((s) => (s.k === k ? { k, dir: (s.dir * -1) as 1 | -1 } : { k, dir: firstDir })); };
  const th = (k: Key, label: string, firstDir: 1 | -1 = 1, title?: string) => (
    <th aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={title}>
      <button className="th-btn" onClick={by(k, firstDir)}>{label}<span className="sort-ind">{sort.k === k ? (sort.dir === 1 ? "▲" : "▼") : ""}</span></button>
    </th>
  );
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(0); };

  return (
    <>
      <div className="table-tools">
        <input className="search" type="search" placeholder="Search name, website, town…" value={q} onChange={(e) => reset(setQ)(e.target.value)} aria-label="Search leads" />
        <select value={niche} onChange={(e) => reset(setNiche)(e.target.value)} aria-label="Industry">
          <option value="">All industries</option>{niches.map((n) => <option key={n} value={n}>{NICHE_LABEL[n] ?? n}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={hideSkipped} onChange={(e) => reset(setHideSkipped)(e.target.checked)} /> Hide skipped</label>
        <label className="check"><input type="checkbox" checked={emailOnly} onChange={(e) => reset(setEmailOnly)(e.target.checked)} /> Has email</label>
        <label className="check">Min opportunity <input type="number" min={0} max={100} className="num" value={minScore} onChange={(e) => reset(setMinScore)(Number(e.target.value))} /></label>
        <span className="muted small">{view.length} of {rows.length}</span>
      </div>
      <div className="table-wrap">
        <table className="leads">
          <colgroup>
            <col className="c-name" /><col className="c-health" /><col className="c-opp" /><col className="c-niche" />
            <col className="c-issue" /><col className="c-contact" /><col className="c-status" /><col className="c-follow" />
          </colgroup>
          <thead><tr>
            {th("name", "Business")}
            {th("health", "Health", 1, "Site Health: higher is a better website")}
            {th("score", "Opp.", -1, "Opportunity: higher is a better lead")}
            {th("niche", "Industry")}
            <th>Top issue</th><th>Contact</th>
            {th("status", "Status")}
            {th("follow", "Follow up")}
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.business.id}>
                <td className="cell-name">
                  <Link to={`/leads/${r.business.id}`} title={r.business.name}>{r.business.name}</Link>
                  {r.business.last_error && <span className="warn-ico" title={r.business.last_error}>⚠</span>}
                  <div className="sub" title={r.business.website_url ?? ""}>{host(r.business.website_url) || "no website"}</div>
                </td>
                <td><MiniGauge score={r.health} /></td>
                <td><span className={`opp ${r.score === null ? "" : r.score >= 60 ? "hot" : r.score >= 25 ? "warm" : "cool"}`}>{r.score ?? "…"}</span>
                  {r.partial && <span className="dot-partial" title="Google's speed test didn't run">•</span>}</td>
                <td className="clip" title={r.niche ? NICHE_LABEL[r.niche] : ""}>{r.niche ? NICHE_LABEL[r.niche] ?? r.niche : <span className="muted">—</span>}</td>
                <td><span className="clamp2" title={r.topFinding ?? ""}>{r.topFinding ?? <span className="muted">—</span>}</span>
                  {r.offer && <span className="sub">{OFFER_LABEL[r.offer] ?? r.offer}</span>}</td>
                <td className="clip" title={r.poc ? `${r.poc.name}${r.poc.email ? ` <${r.poc.email}>` : ""}` : r.bestContact ?? ""}>
                  {r.poc ? <><strong>{r.poc.name}</strong><div className="sub">{r.poc.email ?? r.bestContact ?? ""}</div></> : r.bestContact ?? <span className="muted">none</span>}
                </td>
                <td><span className={`status s-${r.business.lead_status}`}>{r.business.lead_status}</span></td>
                <td className="nowrap">{r.business.follow_up_at ? new Date(`${r.business.follow_up_at}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="muted empty">No leads match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>← Prev</button>
          <span className="muted small">Page {Math.min(page, pages - 1) + 1} of {pages}</span>
          <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next →</button>
        </div>
      )}
    </>
  );
}
