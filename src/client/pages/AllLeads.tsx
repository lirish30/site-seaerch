import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { STATUSES, type LeadRow, type LeadStatus } from "../types";
import LeadTable from "./LeadTable";

export default function AllLeads() {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false; // ignore responses for a filter the user has already changed away from
    setRows(null); setErr("");
    api.get<LeadRow[]>(`/leads${status ? `?status=${status}` : ""}`)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load leads."); });
    return () => { cancelled = true; };
  }, [status]);
  return (
    <div>
      <div className="row"><h2 style={{ margin: 0 }}>All leads</h2>
        <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {err ? <p className="error">{err}</p> : rows ? <LeadTable rows={rows} /> : <p>Loading…</p>}
    </div>
  );
}
