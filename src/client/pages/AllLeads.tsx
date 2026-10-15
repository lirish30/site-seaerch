import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import SavedFilters from "../components/SavedFilters";
import { defaultView, parseView, serializeView, type LeadView } from "../savedFilters";
import type { LeadRow } from "../types";
import type { TableFilters } from "../leadFilters";
import LeadTable from "./LeadTable";

const STAGE_TITLE: Record<string, string> = { new: "New", reviewed: "Reviewed", contacted: "Contacted", replied: "Replied", won: "Won", lost: "Lost", skip: "Skipped" };

/**
 * The status, archived and starred views live in the URL (the Leads sidebar links to them, e.g. /leads?status=new), so a link or a reload
 * opens the same list. The tag filter and the table's own filters stay in page state.
 */
export default function AllLeads() {
  const [params, setParams] = useSearchParams();
  const [tag, setTagState] = useState("");
  const [table, setTable] = useState<TableFilters>(defaultView.table);
  const fromUrl = useMemo(() => parseView(params.toString()), [params]);
  const view: LeadView = { status: fromUrl.status, archived: fromUrl.archived, starred: fromUrl.starred, tag, table };
  const { status, archived, starred } = view;
  // The tag box is typed into freely; it only becomes the filter on Enter or blur, so each keystroke doesn't refetch.
  const [tagDraft, setTagDraft] = useState("");
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [err, setErr] = useState("");
  const [reloads, setReloads] = useState(0);
  const loadedFor = useRef("");

  const setSlice = (p: Pick<LeadView, "status" | "archived" | "starred">) => {
    const q = new URLSearchParams();
    if (p.status) q.set("status", p.status);
    if (p.archived) q.set("archived", "1");
    if (p.starred) q.set("starred", "1");
    setParams(q);
  };
  const applyTag = (t: string) => { const n = t.trim().toLowerCase(); setTagDraft(n); setTagState(n); };

  useEffect(() => {
    let cancelled = false; // ignore responses for a filter the user has already changed away from
    // A new filter shows "Loading…"; a reload after a bulk change keeps the table on screen.
    const key = `${status}|${archived}|${tag}|${starred}`;
    if (loadedFor.current !== key) { loadedFor.current = key; setRows(null); }
    setErr("");
    const q = new URLSearchParams({ limit: "500", ...(status ? { status } : {}), ...(archived ? { archived: "1" } : {}), ...(tag ? { tag } : {}), ...(starred ? { starred: "1" } : {}) });
    api.get<LeadRow[]>(`/leads?${q}`)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load leads."); });
    return () => { cancelled = true; };
  }, [status, archived, tag, starred, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  const tags = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.business.tags))].sort(), [rows]);
  const current = serializeView(view);
  const apply = (query: string) => { const v = parseView(query); setSlice(v); setTable(v.table); applyTag(v.tag); };

  const title = archived ? "Archived leads" : starred ? "Starred" : status ? STAGE_TITLE[status] : "All leads";
  return (
    <div className="leads-page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p className="muted">{rows ? `${rows.length} ${rows.length === 1 ? "lead" : "leads"} · sorted by lead score, starred first` : "Loading…"}</p>
        </div>
        <div className="header-actions">
          <Link to="/import" className="btn"><Icon name="upload" size={16} />Import</Link>
          <Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link>
        </div>
      </header>
      <div className="panel-body">
        {err && <p className="error" role="alert">{err}</p>}
        {rows ? (
          <LeadTable rows={rows} filters={table} onFiltersChange={setTable} bulk={{ onChanged: reload, archivedView: archived }} onTagClick={applyTag}
            moreFilters={<>
              <label className="check">Tag
                <input className="tag-filter" list="lead-tags" value={tagDraft} placeholder="Any tag" aria-label="Tag filter" maxLength={32}
                  onChange={(e) => setTagDraft(e.target.value)} onBlur={() => applyTag(tagDraft)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyTag(tagDraft); }} />
              </label>
              <datalist id="lead-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
              <SavedFilters current={current} onApply={apply} />
            </>} />
        ) : !err && <p className="muted">Loading…</p>}
      </div>
    </div>
  );
}
