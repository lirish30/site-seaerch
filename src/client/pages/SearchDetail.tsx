import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { LeadRow, Search } from "../types";
import LeadTable from "./LeadTable";

export default function SearchDetail() {
  const { id } = useParams();
  const [data, setData] = useState<{ search: Search; leads: LeadRow[] } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const d = await api.get<{ search: Search; leads: LeadRow[] }>(`/searches/${id}`);
      setData(d);
      const finished = d.search.status === "failed" || (d.search.status === "done" && d.search.processed_count >= d.search.found_count);
      if (!finished) timer = setTimeout(load, 4000);
    };
    load();
    return () => clearTimeout(timer);
  }, [id]);

  if (!data) return <p>Loading…</p>;
  const { search, leads } = data;
  return (
    <div>
      <h2>{search.business_type} in {search.location}</h2>
      {search.status === "failed"
        ? <p className="error">Search failed: {search.error}</p>
        : <div className="card">
            <div className="row"><span>{search.processed_count} of {search.found_count || "?"} businesses audited</span>
              {search.status === "running" && search.found_count === 0 && <span className="muted">Fetching listings…</span>}</div>
            <progress max={search.found_count || 1} value={search.processed_count} />
          </div>}
      <LeadTable rows={leads} />
    </div>
  );
}
