import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import BulkBar from "../components/BulkBar";
import StarToggle from "../components/StarToggle";
import { FitChip } from "../components/FitChip";
import { MiniGauge } from "../components/HealthGauge";
import { compareFit } from "../fitView";
import { NICHE_LABEL, OFFER_LABEL, type LeadRow } from "../types";
import { applyLeadFilters, defaultTableFilters, isStarred, type LeadFilters, NOT_CRAWLED, OFFERS, platformOptions, starredFirst, type TableFilters } from "../leadFilters";
import { allSelected, pruneSelection, someSelected, toggleId, togglePage } from "../bulkView";

type Key = "name" | "health" | "score" | "fit" | "niche" | "status" | "follow";
const PAGE = 50;
const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function value(r: LeadRow, k: Exclude<Key, "fit">): string | number {
  switch (k) {
    case "name": return r.business.name.toLowerCase();
    case "health": return r.health ?? 101; // unmeasured sorts last ascending
    case "score": return r.score ?? -1;
    case "niche": return r.niche ?? "~";
    case "status": return r.business.lead_status;
    case "follow": return r.business.follow_up_at ?? "9999";
  }
}

/**
 * `filters`/`onFiltersChange` let a page own the filter state (to save and restore it); without them the table keeps its own.
 * `bulk` turns on row checkboxes, the selection bar and the ★ on each row; `onChanged` reloads the rows after a bulk change, an undo or a star.
 * Starred rows always sort above the rest, whichever column is sorted.
 */
export default function LeadTable({ rows, filters, onFiltersChange, bulk, onTagClick }: {
  rows: LeadRow[]; filters?: TableFilters; onFiltersChange?: (t: TableFilters) => void;
  bulk?: { onChanged: () => void | Promise<void>; archivedView?: boolean }; onTagClick?: (tag: string) => void;
}) {
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: "score", dir: -1 });
  const [own, setOwn] = useState<TableFilters>(defaultTableFilters);
  const { f, q, niche } = filters ?? own;
  const setTable = (p: Partial<TableFilters>) => { (onFiltersChange ?? setOwn)({ f, q, niche, ...p }); setPage(0); };
  const setQ = (v: string) => setTable({ q: v });
  const setNiche = (v: string) => setTable({ niche: v });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const set = (p: Partial<LeadFilters>) => setTable({ f: { ...f, ...p } });
  const num = (v: string) => (v === "" ? null : Number(v));

  const niches = useMemo(() => [...new Set(rows.map((r) => r.niche).filter((x): x is string => !!x))].sort(), [rows]);
  const platforms = useMemo(() => platformOptions(rows), [rows]);
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return starredFirst(applyLeadFilters(rows, f)
      .filter((r) => !niche || r.niche === niche)
      .filter((r) => !needle || `${r.business.name} ${r.business.website_url ?? ""} ${r.business.address ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort.k === "fit") return compareFit(a.fit, b.fit, sort.dir) || a.business.name.localeCompare(b.business.name);
        const x = value(a, sort.k), y = value(b, sort.k);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.business.name.localeCompare(b.business.name);
      }));
  }, [rows, sort, f, q, niche]);
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const shown = view.slice(Math.min(page, pages - 1) * PAGE, Math.min(page, pages - 1) * PAGE + PAGE);

  const by = (k: Key, firstDir: 1 | -1 = 1) => () => { setPage(0); setSort((s) => (s.k === k ? { k, dir: (s.dir * -1) as 1 | -1 } : { k, dir: firstDir })); };
  const th = (k: Key, label: string, firstDir: 1 | -1 = 1, title?: string) => (
    <th aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={title}>
      <button className="th-btn" onClick={by(k, firstDir)}>{label}<span className="sort-ind">{sort.k === k ? (sort.dir === 1 ? "▲" : "▼") : ""}</span></button>
    </th>
  );

  // A selection only ever covers rows the user can see: filtering or reloading drops anything that left the view.
  const viewIds = useMemo(() => view.map((r) => r.business.id), [view]);
  useEffect(() => { setSelected((s) => pruneSelection(s, viewIds)); }, [viewIds]);
  const pageIds = shown.map((r) => r.business.id);
  const headBox = useRef<HTMLInputElement>(null);

  // One star request per lead at a time; the rows reload afterwards so the lead moves to the top of the list.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [starBusy, setStarBusy] = useState<ReadonlySet<string>>(new Set());
  const [starErr, setStarErr] = useState("");
  const toggleStar = async (r: LeadRow) => {
    const id = r.business.id;
    if (starBusy.has(id) || !bulk) return;
    setStarBusy((s) => new Set(s).add(id)); setStarErr("");
    try {
      await api.patch(`/leads/${id}`, { starred: !isStarred(r) });
      await Promise.resolve(bulk.onChanged()).catch(() => { /* the page reports its own load errors */ });
    } catch (e) {
      if (alive.current) setStarErr(e instanceof ApiError && e.status < 500 && e.message ? e.message : `Couldn't ${isStarred(r) ? "unstar" : "star"} ${r.business.name}. Try again.`);
    } finally {
      if (alive.current) setStarBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };
  useEffect(() => { if (headBox.current) headBox.current.indeterminate = someSelected(selected, pageIds) && !allSelected(selected, pageIds); });

  return (
    <>
      {bulk && <BulkBar selected={[...selected]} archivedView={bulk.archivedView} onClear={() => setSelected(new Set())} onDone={bulk.onChanged} />}
      <div className="table-tools">
        <input className="search" type="search" placeholder="Search name, website, town…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
        <select value={niche} onChange={(e) => setNiche(e.target.value)} aria-label="Industry">
          <option value="">All industries</option>{niches.map((n) => <option key={n} value={n}>{NICHE_LABEL[n] ?? n}</option>)}
        </select>
        <select value={f.offer} onChange={(e) => set({ offer: e.target.value as LeadFilters["offer"] })} aria-label="Offer">
          <option value="any">Any offer</option>{OFFERS.map((o) => <option key={o} value={o}>{OFFER_LABEL[o] ?? o}</option>)}
        </select>
        <select value={f.platform} onChange={(e) => set({ platform: e.target.value })} aria-label="Platform">
          <option value="any">Any platform</option>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}<option value={NOT_CRAWLED}>not crawled</option>
        </select>
        <label className="check"><input type="checkbox" checked={f.hideSkipped} onChange={(e) => set({ hideSkipped: e.target.checked })} /> Hide skipped</label>
        <label className="check"><input type="checkbox" checked={f.emailOnly} onChange={(e) => set({ emailOnly: e.target.checked })} /> Has email</label>
        <label className="check">Min opportunity <input type="number" min={0} max={100} className="num" value={f.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} /></label>
        <label className="check">Min reviews <input type="number" min={0} className="num" value={f.minReviews ?? ""} onChange={(e) => set({ minReviews: num(e.target.value) })} /></label>
        <label className="check">Max rating <input type="number" min={0} max={5} step={0.1} className="num" value={f.maxRating ?? ""} onChange={(e) => set({ maxRating: num(e.target.value) })} /></label>
        <span className="muted small">{view.length} of {rows.length}</span>
      </div>
      {starErr && <p className="error" role="alert">{starErr}</p>}
      <div className="table-wrap">
        <table className="leads">
          <colgroup>
            {bulk && <col className="c-check" />}
            <col className="c-name" /><col className="c-health" /><col className="c-opp" /><col className="c-fit" /><col className="c-niche" />
            <col className="c-issue" /><col className="c-contact" /><col className="c-status" /><col className="c-follow" />
          </colgroup>
          <thead><tr>
            {bulk && <th className="check-cell"><input ref={headBox} type="checkbox" aria-label="Select all on this page" disabled={!shown.length}
              checked={allSelected(selected, pageIds)} onChange={() => setSelected(togglePage(selected, pageIds))} /></th>}
            {th("name", "Business")}
            {th("health", "Health", 1, "Site Health: higher is a better website")}
            {th("score", "Opp.", -1, "Opportunity: higher is a better lead")}
            {th("fit", "Fit", -1, "Fit: how well the business matches your best fit profile. — means no profile applies")}
            {th("niche", "Industry")}
            <th>Top issue</th><th>Contact</th>
            {th("status", "Status")}
            {th("follow", "Follow up")}
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.business.id} className={[selected.has(r.business.id) ? "selected" : "", isStarred(r) ? "starred" : ""].filter(Boolean).join(" ") || undefined}>
                {bulk && <td className="check-cell"><input type="checkbox" aria-label={`Select ${r.business.name}`} checked={selected.has(r.business.id)}
                  onChange={() => setSelected(toggleId(selected, r.business.id))} /></td>}
                <td className="cell-name">
                  {bulk && <StarToggle on={isStarred(r)} name={r.business.name} busy={starBusy.has(r.business.id)} onClick={() => void toggleStar(r)} />}
                  <Link to={`/leads/${r.business.id}`} title={r.business.name}>{r.business.name}</Link>
                  {r.business.last_error && <span className="warn-ico" title={r.business.last_error}>⚠</span>}
                  {r.scan_stage === "quick" && <span className="badge quick-scan" title="Crawled and scored only. Run a full scan from the Promising page for screenshots, PageSpeed, AI review and a draft.">Quick scan</span>}
                  <div className="sub" title={r.business.website_url ?? ""}>{host(r.business.website_url) || "no website"}{r.platform && r.platform !== "other" ? ` · ${r.platform}` : ""}</div>
                  {r.business.tags.length > 0 && (
                    <div className="tag-list">{r.business.tags.map((t) => onTagClick
                      ? <button key={t} className="tag" title={`Show only leads tagged "${t}"`} onClick={() => onTagClick(t)}>{t}</button>
                      : <span key={t} className="tag">{t}</span>)}</div>
                  )}
                </td>
                <td><MiniGauge score={r.health} /></td>
                <td><span className={`opp ${r.score === null ? "" : r.score >= 60 ? "hot" : r.score >= 25 ? "warm" : "cool"}`}>{r.score ?? "…"}</span>
                  {r.partial && <span className="dot-partial" title="Google's speed test didn't run">•</span>}</td>
                <td><FitChip fit={r.fit} /></td>
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
            {!shown.length && <tr><td colSpan={bulk ? 10 : 9} className="muted empty">No leads match these filters.</td></tr>}
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
