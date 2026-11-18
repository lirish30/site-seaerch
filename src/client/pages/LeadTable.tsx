import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import BulkBar from "../components/BulkBar";
import StarToggle from "../components/StarToggle";
import { FitChip } from "../components/FitChip";
import Icon from "../components/Icon";
import ScoreLegend from "../components/ScoreLegend";
import { announceLeadsChanged } from "../components/Shell";
import { Badge, LeadScore, Severity, SiteHealth } from "../components/Score";
import { compareFit } from "../fitView";
import { followUpTone, STAGE_LABEL, STAGE_TONE } from "../leadView";
import { CATEGORY_LABEL, NICHE_LABEL, OFFER_LABEL, type LeadRow } from "../types";
import { activeExtraFilters, CATEGORY_OPTIONS, defaultTableFilters, filterLeadRows, isStarred, type LeadFilters, NOT_CRAWLED, OFFERS, platformOptions, STALE_DAYS, starredFirst, type TableFilters } from "../leadFilters";
import { allSelected, pruneSelection, toggleId, togglePage } from "../bulkView";

type Key = "name" | "health" | "score" | "fit" | "status" | "follow";
const PAGE = 50;
const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const PLATFORM_LABEL: Record<string, string> = { wordpress: "WordPress", godaddy: "GoDaddy", wix: "Wix", squarespace: "Squarespace", weebly: "Weebly", shopify: "Shopify", webflow: "Webflow" };

function value(r: LeadRow, k: Exclude<Key, "fit">): string | number {
  switch (k) {
    case "name": return r.business.name.toLowerCase();
    case "health": return r.health ?? 101; // unmeasured sorts last ascending
    case "score": return r.score ?? -1;
    case "status": return r.business.lead_status;
    case "follow": return r.business.follow_up_at ?? "9999";
  }
}

/**
 * `filters`/`onFiltersChange` let a page own the filter state (to save and restore it); without them the table keeps its own.
 * `bulk` turns on row checkboxes, the selection bar and the star on each row; `onChanged` reloads the rows after a bulk change, an undo or a star.
 * Starred rows always sort above the rest, whichever column is sorted.
 * `moreFilters` is extra controls (a tag box, saved filters) shown under the toolbar's "More filters" toggle.
 */
export default function LeadTable({ rows, filters, onFiltersChange, bulk, onTagClick, moreFilters }: {
  rows: LeadRow[]; filters?: TableFilters; onFiltersChange?: (t: TableFilters) => void;
  bulk?: { onChanged: () => void | Promise<void>; archivedView?: boolean }; onTagClick?: (tag: string) => void; moreFilters?: ReactNode;
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
  const [more, setMore] = useState(false);

  const niches = useMemo(() => [...new Set(rows.map((r) => r.niche).filter((x): x is string => !!x))].sort(), [rows]);
  const platforms = useMemo(() => platformOptions(rows), [rows]);
  const view = useMemo(() => {
    return starredFirst(filterLeadRows(rows, { f, q, niche })
      .sort((a, b) => {
        if (sort.k === "fit") return compareFit(a.fit, b.fit, sort.dir) || a.business.name.localeCompare(b.business.name);
        const x = value(a, sort.k), y = value(b, sort.k);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.business.name.localeCompare(b.business.name);
      }));
  }, [rows, sort, f, q, niche]);
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const from = Math.min(page, pages - 1) * PAGE;
  const shown = view.slice(from, from + PAGE);

  const by = (k: Key, firstDir: 1 | -1 = 1) => () => { setPage(0); setSort((s) => (s.k === k ? { k, dir: (s.dir * -1) as 1 | -1 } : { k, dir: firstDir })); };
  const th = (k: Key, label: string, firstDir: 1 | -1 = 1, title?: string) => (
    <th aria-sort={sort.k === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={title}>
      <button className="th-btn" data-active={sort.k === k} onClick={by(k, firstDir)}>{label}
        {sort.k === k && <Icon name="chevron-down" size={12} className={sort.dir === 1 ? "flip" : undefined} />}
        {title && <Icon name="info" size={12} className="th-info" />}
      </button>
    </th>
  );

  // A selection only ever covers rows the user can see: filtering or reloading drops anything that left the view.
  const viewIds = useMemo(() => view.map((r) => r.business.id), [view]);
  useEffect(() => { setSelected((s) => pruneSelection(s, viewIds)); }, [viewIds]);
  const pageIds = shown.map((r) => r.business.id);
  // The lead page offers previous / next within the list the user came from, and "All leads" goes back to this exact view.
  useEffect(() => {
    try { sessionStorage.setItem("leads:order", JSON.stringify(viewIds)); sessionStorage.setItem("leads:list", location.pathname + location.search); } catch { /* storage unavailable */ }
  }, [viewIds]);

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
      announceLeadsChanged();
    } catch (e) {
      if (alive.current) setStarErr(e instanceof ApiError && e.status < 500 && e.message ? e.message : `Couldn't ${isStarred(r) ? "unstar" : "star"} ${r.business.name}. Try again.`);
    } finally {
      if (alive.current) setStarBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };
  const selectedRows = rows.filter((r) => selected.has(r.business.id));
  const extraCount = activeExtraFilters(f);
  const filterCount = (f.offer !== "any" ? 1 : 0) + (f.platform !== "any" ? 1 : 0) + (f.website !== "any" ? 1 : 0) + (niche ? 1 : 0) + extraCount;

  return (
    <>
      <div className="table-tools">
        <label className="search-box"><Icon name="search" size={14} />
          <input type="search" placeholder="Search name, website, town…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
        </label>
        <label className={`filter${niche ? " on" : ""}`}><span>Industry</span>
          <select value={niche} onChange={(e) => setNiche(e.target.value)} aria-label="Industry">
            <option value="">All</option>{niches.map((n) => <option key={n} value={n}>{NICHE_LABEL[n] ?? n}</option>)}
          </select><Icon name="chevron-down" size={14} /></label>
        <label className={`filter${f.offer !== "any" ? " on" : ""}`}><span>Offer</span>
          <select value={f.offer} onChange={(e) => set({ offer: e.target.value as LeadFilters["offer"] })} aria-label="Offer">
            <option value="any">Any</option>{OFFERS.map((o) => <option key={o} value={o}>{OFFER_LABEL[o] ?? o}</option>)}
          </select><Icon name="chevron-down" size={14} /></label>
        <label className={`filter${f.platform !== "any" ? " on" : ""}`}><span>Platform</span>
          <select value={f.platform} onChange={(e) => set({ platform: e.target.value })} aria-label="Platform">
            <option value="any">Any</option>{platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</option>)}<option value={NOT_CRAWLED}>Not crawled</option>
          </select><Icon name="chevron-down" size={14} /></label>
        <label className={`filter${f.website !== "any" ? " on" : ""}`}><span>Website</span>
          <select value={f.website} onChange={(e) => set({ website: e.target.value as LeadFilters["website"] })} aria-label="Website">
            <option value="any">Any</option><option value="yes">Has website</option><option value="no">No website</option>
          </select><Icon name="chevron-down" size={14} /></label>
        <button className="ghost" aria-expanded={more} aria-controls="more-filters" onClick={() => setMore((m) => !m)}><Icon name="plus" size={14} />More filters{extraCount ? ` (${extraCount})` : ""}</button>
        <span className="grow" />
        <label className="switch"><input type="checkbox" role="switch" checked={f.hideSkipped} onChange={(e) => set({ hideSkipped: e.target.checked })} /><i aria-hidden="true" /><span>Hide skipped</span></label>
      </div>
      {more && (
        <div className="more-filters" id="more-filters">
          <label className="check"><input className="cb" type="checkbox" checked={f.emailOnly} onChange={(e) => set({ emailOnly: e.target.checked })} /> Has email</label>
          <label className="check">Min lead score <input type="number" min={0} max={100} className="num" value={f.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} /></label>
          <label className="check">Min reviews <input type="number" min={0} className="num" value={f.minReviews ?? ""} onChange={(e) => set({ minReviews: num(e.target.value) })} /></label>
          <label className="check">Max rating <input type="number" min={0} max={5} step={0.1} className="num" value={f.maxRating ?? ""} onChange={(e) => set({ maxRating: num(e.target.value) })} /></label>
          <label className="check"><input className="cb" type="checkbox" checked={f.hasPhone} onChange={(e) => set({ hasPhone: e.target.checked })} /> Has phone</label>
          <label className="check"><input className="cb" type="checkbox" checked={f.hasContact} onChange={(e) => set({ hasContact: e.target.checked })} /> Has named contact</label>
          <label className="check">Outreach
            <select value={f.outreach} onChange={(e) => set({ outreach: e.target.value as LeadFilters["outreach"] })} aria-label="Outreach">
              <option value="any">Any</option><option value="never">Never contacted</option><option value="followup">Follow-up due</option>
              <option value="stale">{`No reply in ${STALE_DAYS}+ days`}</option>
            </select></label>
          <label className="check">Max site health <input type="number" min={0} max={100} className="num" value={f.maxHealth ?? ""} onChange={(e) => set({ maxHealth: num(e.target.value) })} /></label>
          <label className="check">Top issue
            <select value={f.category} onChange={(e) => set({ category: e.target.value as LeadFilters["category"] })} aria-label="Top issue">
              <option value="any">Any</option>{CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select></label>
          <label className="check"><input className="cb" type="checkbox" checked={f.criticalOnly} onChange={(e) => set({ criticalOnly: e.target.checked })} /> Critical issue only</label>
          <label className="check">Min fit <input type="number" min={0} max={100} className="num" value={f.minFit ?? ""} onChange={(e) => set({ minFit: num(e.target.value) })} /></label>
          <label className="check">Added
            <select value={f.addedDays ?? ""} onChange={(e) => set({ addedDays: num(e.target.value) })} aria-label="Added">
              <option value="">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            </select></label>
          <label className="check">Scan
            <select value={f.scan} onChange={(e) => set({ scan: e.target.value as LeadFilters["scan"] })} aria-label="Scan depth">
              <option value="any">Any</option><option value="quick">Quick only</option><option value="full">Full only</option>
            </select></label>
          {moreFilters}
        </div>
      )}
      <ScoreLegend />
      {starErr && <p className="error" role="alert">{starErr}</p>}
      <div className="table-card">
        {bulk && <BulkBar selected={[...selected]} archivedView={bulk.archivedView} allStarred={selectedRows.length > 0 && selectedRows.every(isStarred)}
          onClear={() => setSelected(new Set())} onDone={async () => { await bulk.onChanged(); announceLeadsChanged(); }} />}
        <div className="table-scroll">
          <table className="leads">
            <colgroup>
              {bulk && <col className="c-check" />}
              <col className="c-name" /><col className="c-score" /><col className="c-health" /><col className="c-fit" />
              <col className="c-issue" /><col className="c-contact" /><col className="c-status" /><col className="c-follow" />
            </colgroup>
            <thead><tr>
              {bulk && <th className="check-cell"><input className="cb" type="checkbox" aria-label="Select all on this page" disabled={!shown.length}
                checked={allSelected(selected, pageIds)} onChange={() => setSelected(togglePage(selected, pageIds))} /></th>}
              {th("name", "Business")}
              {th("score", "Lead score", -1, "Lead score: how strong a prospect is. Higher is better.")}
              {th("health", "Site health", 1, "Site health: how good their site is now. Low = more to fix.")}
              {th("fit", "Fit", -1, "Fit: how well the business matches your best fit profile. — means no profile applies")}
              <th>Biggest problem</th><th>Contact</th>
              {th("status", "Stage")}
              {th("follow", "Follow up")}
            </tr></thead>
            <tbody>
              {shown.map((r) => {
                const b = r.business;
                const poc = r.poc;
                const contactSub = poc ? (poc.email ?? r.bestContact) : r.bestContact;
                return (
                  <tr key={b.id} className={selected.has(b.id) ? "selected" : undefined}>
                    {bulk && <td className="check-cell"><input className="cb" type="checkbox" aria-label={`Select ${b.name}`} checked={selected.has(b.id)}
                      onChange={() => setSelected(toggleId(selected, b.id))} /></td>}
                    <td className="cell-name">
                      <div className="name-line">
                        {bulk && <StarToggle on={isStarred(r)} name={b.name} busy={starBusy.has(b.id)} onClick={() => void toggleStar(r)} />}
                        <Link to={`/leads/${b.id}`} title={b.name}>{b.name}</Link>
                        {b.last_error && <span className="warn-ico" title={b.last_error}><Icon name="alert" size={13} /></span>}
                        {r.scan_stage === "quick" && <Badge tone="outline" title="Crawled and scored only. Run a full scan from Needs full scan for screenshots, PageSpeed, AI review and a draft.">Quick scan</Badge>}
                      </div>
                      <span className="sub" title={b.website_url ?? ""}>{host(b.website_url) ? `${host(b.website_url)}${r.platform && r.platform !== "other" ? ` · ${PLATFORM_LABEL[r.platform] ?? r.platform}` : ""}` : "No website · Google Maps only"}</span>
                      {b.tags.length > 0 && (
                        <div className="tag-list">{b.tags.map((t) => onTagClick
                          ? <button key={t} className="tag" title={`Show only leads tagged "${t}"`} onClick={() => onTagClick(t)}>{t}</button>
                          : <span key={t} className="tag">{t}</span>)}</div>
                      )}
                    </td>
                    <td><LeadScore score={r.score} /></td>
                    <td><SiteHealth health={r.health} noSite={!b.website_url} partial={r.partial} /></td>
                    <td><FitChip fit={r.fit} /></td>
                    <td className="cell-issue" title={r.topFinding ?? ""}>
                      {r.topFinding ? <>
                        <span className="sev-line">{r.topSeverity && <Severity severity={r.topSeverity} />}{r.topCategory && <span>· {CATEGORY_LABEL[r.topCategory]}</span>}</span>
                        <span className="what">{r.topFinding}</span>
                      </> : <span className="muted2">—</span>}
                    </td>
                    <td className="cell-contact" title={poc ? `${poc.name}${poc.email ? ` <${poc.email}>` : ""}` : r.bestContact ?? ""}>
                      <span className={`who${poc ? "" : " none"}`}>{poc ? poc.name : "No contact yet"}</span>
                      {contactSub && <span className="sub">{contactSub}</span>}
                    </td>
                    <td><Badge tone={STAGE_TONE[b.lead_status]} dot={STAGE_TONE[b.lead_status] !== "outline" || b.lead_status === "new"}>{STAGE_LABEL[b.lead_status]}</Badge></td>
                    <td className={`follow ${followUpTone(b.follow_up_at)}`}>{b.follow_up_at ? followUpText(b.follow_up_at) : <span className="muted2">—</span>}</td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={bulk ? 9 : 8} className="empty">No leads match these filters{filterCount ? ` (${filterCount} filter${filterCount === 1 ? "" : "s"} on)` : ""}.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="grow">{view.length ? `Showing ${from + 1}–${from + shown.length} of ${view.length}` : "No leads to show"}</span>
          {pages > 1 && <>
            <button className="btn sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><Icon name="chevron-left" size={16} />Previous</button>
            <button className="btn sm" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next</button>
          </>}
        </div>
      </div>
    </>
  );
}

/** "Oct 12", or "Today" on the day itself. */
function followUpText(day: string): string {
  const d = new Date(`${day}T00:00`), n = new Date();
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return "Today";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
