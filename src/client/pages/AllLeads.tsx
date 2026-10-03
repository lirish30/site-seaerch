import { useEffect, useState } from "react";
import { api } from "../api";
import { STATUSES, type LeadRow, type LeadStatus } from "../types";
import LeadTable from "./LeadTable";

export default function AllLeads() {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<LeadRow[]>(`/leads${status ? `?status=${status}` : ""}`).then(setRows); }, [status]);
  return (
    <div>
      <div className="row"><h2 style={{ margin: 0 }}>All leads</h2>
        <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {rows ? <LeadTable rows={rows} /> : <p>Loading…</p>}
    </div>
  );
}
