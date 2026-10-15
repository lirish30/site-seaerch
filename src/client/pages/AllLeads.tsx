import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import SavedFilters from "../components/SavedFilters";
import { parseView, serializeView, type LeadView } from "../savedFilters";
import { isDraftReady, type TableFilters } from "../leadFilters";
import { STAGE_LABEL } from "../leadView";
import type { LeadRow } from "../types";
import LeadTable from "./LeadTable";

/**
 * Every filter lives in the URL (the Leads sidebar and saved filters link to it, e.g. /leads?status=new), so a link, a reload or the back
 * button opens the same list. The server is asked for status, tag, starred and archived; the rest filters what came back.
 */
export default function AllLeads() {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => parseView(params.toString()), [params]);
  const { status, archived, starred, drafts, tag } = view;
  const [tagDraft, setTagDraft] = useState(tag);
  useEffect(() => setTagDraft(tag), [tag]);
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [err, setErr] = useState("");
  const [reloads, setReloads] = useState(0);
  const loadedFor = useRef("");

  // Editing a filter replaces the URL entry (so Back leaves the page); the sidebar's links push new ones.
  const setView = (next: LeadView) => setParams(new URLSearchParams(serializeView(next)), { replace: true });
  const setTable = (table: TableFilters) => setView({ ...view, table });
  const applyTag = (t: string) => { const n = t.trim().toLowerCase(); setTagDraft(n); setView({ ...view, tag: n }); };

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

  const shownRows = useMemo(() => (rows && drafts ? rows.filter(isDraftReady) : rows), [rows, drafts]);
  const tags = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.business.tags))].sort(), [rows]);
  const apply = (query: string) => setParams(new URLSearchParams(serializeView(parseView(query))));

  const title = archived ? "Archived leads" : starred ? "Starred" : drafts ? "Drafts ready" : status ? STAGE_LABEL[status] : "All leads";
  return (
    <div className="leads-page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p>{shownRows ? `${shownRows.length} ${shownRows.length === 1 ? "lead" : "leads"} · sorted by lead score, starred first` : "Loading…"}</p>
        </div>
        <div className="header-actions">
          <Link to="/import" className="btn"><Icon name="upload" size={16} />Import</Link>
          <Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link>
        </div>
      </header>
      <div className="page-body">
        {err && <p className="error" role="alert">{err}</p>}
        {shownRows ? (
          <LeadTable rows={shownRows} filters={view.table} onFiltersChange={setTable} bulk={{ onChanged: reload, archivedView: archived }} onTagClick={applyTag}
            moreFilters={<>
              <label className="check">Tag
                <input className="tag-filter" list="lead-tags" value={tagDraft} placeholder="Any tag" aria-label="Tag filter" maxLength={32}
                  onChange={(e) => setTagDraft(e.target.value)} onBlur={() => applyTag(tagDraft)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyTag(tagDraft); }} />
              </label>
              <datalist id="lead-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
              <SavedFilters current={serializeView(view)} onApply={apply} />
            </>} />
        ) : !err && <p className="muted">Loading…</p>}
      </div>
    </div>
  );
}
