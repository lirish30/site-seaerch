import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { STATUSES, type LeadRow, type LeadStatus } from "../types";
import LeadTable from "./LeadTable";

export default function AllLeads() {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false; // ignore responses for a filter the user has already changed away from
    setRows(null); setErr("");
    const q = new URLSearchParams({ limit: "500", ...(status ? { status } : {}), ...(archived ? { archived: "1" } : {}) });
    api.get<LeadRow[]>(`/leads?${q}`)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load leads."); });
    return () => { cancelled = true; };
  }, [status, archived]);
  return (
    <div>
      <div className="row between page-head">
        <h2>{archived ? "Archived leads" : "All leads"}</h2>
        <div className="row">
          <select className="auto" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")} aria-label="Status">
            <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <div className="segmented small-seg" role="group" aria-label="Show">
            <button className={!archived ? "on" : ""} aria-pressed={!archived} onClick={() => setArchived(false)}>Active</button>
            <button className={archived ? "on" : ""} aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
          </div>
        </div>
      </div>
      {err ? <p className="error">{err}</p> : rows ? <LeadTable rows={rows} /> : <p>Loading…</p>}
    </div>
  );
}
