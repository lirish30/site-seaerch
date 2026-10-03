import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { pollDelay, searchFinished } from "../poll";
import type { LeadRow, Search } from "../types";
import LeadTable from "./LeadTable";

export default function SearchDetail() {
  const { id } = useParams();
  const notice = (useLocation().state as { notice?: string } | null)?.notice; // e.g. Radar couldn't be saved after NewSearch
  const [data, setData] = useState<{ search: Search; leads: LeadRow[] } | null>(null);
  const [refreshErr, setRefreshErr] = useState("");
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setData(null); setRefreshErr(""); setNotFound(false);
    const load = async () => {
      try {
        const d = await api.get<{ search: Search; leads: LeadRow[] }>(`/searches/${id}`);
        if (cancelled) return;
        failures = 0;
        setData(d); setRefreshErr("");
        if (searchFinished(d.search)) return;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) { setNotFound(true); return; }
        failures++;
        setRefreshErr("Couldn't refresh, retrying…");
      }
      timer = setTimeout(load, pollDelay(failures));
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);

  if (notFound) return <p className="error">Search not found.</p>;
  if (!data) return refreshErr ? <p className="error">{refreshErr}</p> : <p>Loading…</p>;
  const { search, leads } = data;
  return (
    <div>
      <h2>{search.business_type} in {search.location}</h2>
      {notice && <p className="muted" role="status">{notice}</p>}
      {refreshErr && <p className="error">{refreshErr}</p>}
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
