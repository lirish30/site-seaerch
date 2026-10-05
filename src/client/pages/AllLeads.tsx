import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import SavedFilters from "../components/SavedFilters";
import { defaultView, parseView, serializeView, type LeadView } from "../savedFilters";
import { STATUSES, type LeadRow, type LeadStatus } from "../types";
import type { TableFilters } from "../leadFilters";
import LeadTable from "./LeadTable";

export default function AllLeads() {
  const [view, setView] = useState<LeadView>(defaultView);
  const { status, archived, tag } = view;
  // The tag box is typed into freely; it only becomes the filter on Enter or blur, so each keystroke doesn't refetch.
  const [tagDraft, setTagDraft] = useState("");
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [err, setErr] = useState("");
  const [reloads, setReloads] = useState(0);
  const loadedFor = useRef("");
  const patch = (p: Partial<LeadView>) => setView((v) => ({ ...v, ...p }));
  const setTable = (table: TableFilters) => patch({ table });
  const applyTag = (t: string) => { const n = t.trim().toLowerCase(); setTagDraft(n); patch({ tag: n }); };

  useEffect(() => {
    let cancelled = false; // ignore responses for a filter the user has already changed away from
    // A new filter shows "Loading…"; a reload after a bulk change keeps the table on screen.
    const key = `${status}|${archived}|${tag}`;
    if (loadedFor.current !== key) { loadedFor.current = key; setRows(null); }
    setErr("");
    const q = new URLSearchParams({ limit: "500", ...(status ? { status } : {}), ...(archived ? { archived: "1" } : {}), ...(tag ? { tag } : {}) });
    api.get<LeadRow[]>(`/leads?${q}`)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load leads."); });
    return () => { cancelled = true; };
  }, [status, archived, tag, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  const tags = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.business.tags))].sort(), [rows]);
  const current = serializeView(view);
  const apply = (query: string) => { const v = parseView(query); setView(v); setTagDraft(v.tag); };

  return (
    <div>
      <div className="row between page-head">
        <h2>{archived ? "Archived leads" : "All leads"}</h2>
        <div className="row">
          <SavedFilters current={current} onApply={apply} />
          <select className="auto" value={status} onChange={(e) => patch({ status: e.target.value as LeadStatus | "" })} aria-label="Status">
            <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <input className="tag-filter" list="lead-tags" value={tagDraft} placeholder="Tag" aria-label="Tag filter" maxLength={32}
            onChange={(e) => setTagDraft(e.target.value)} onBlur={() => applyTag(tagDraft)}
            onKeyDown={(e) => { if (e.key === "Enter") applyTag(tagDraft); }} />
          <datalist id="lead-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
          <div className="segmented small-seg" role="group" aria-label="Show">
            <button className={!archived ? "on" : ""} aria-pressed={!archived} onClick={() => patch({ archived: false })}>Active</button>
            <button className={archived ? "on" : ""} aria-pressed={archived} onClick={() => patch({ archived: true })}>Archived</button>
          </div>
        </div>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {rows ? <LeadTable rows={rows} filters={view.table} onFiltersChange={setTable} bulk={{ onChanged: reload, archivedView: archived }} onTagClick={applyTag} />
        : !err && <p>Loading…</p>}
    </div>
  );
}
