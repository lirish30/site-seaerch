import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ageLabel, seenRecently, sourceLine } from "../jobsView";
import type { CareerSource, JobPosting } from "../types";

interface Data { source: CareerSource | null; postings: JobPosting[] }

export default function JobsPanel({ businessId }: { businessId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try { const d = await api.get<Data>(`/jobs/leads/${businessId}`); if (alive.current) { setData(d); setErr(""); } }
    catch (e) { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load their open roles."); }
  }, [businessId]);
  useEffect(() => { load(); }, [load]);

  async function check() {
    setBusy(true); setErr("");
    try { const d = await api.post<Data>(`/jobs/leads/${businessId}/check`); if (alive.current) setData(d); }
    catch (e) { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't check their job board."); }
    if (alive.current) setBusy(false);
  }

  const now = new Date();
  // Only roles the board showed recently count as open, same as the server routes and drafts.
  const open = data?.postings.filter((p) => !p.closed_at && p.role_kind && seenRecently(p, now)) ?? [];
  return (
    <section className="card jobs-panel" aria-label="Open roles">
      <div className="row between"><h3>Open roles</h3><button onClick={check} disabled={busy}>{busy ? "Checking…" : "Check now"}</button></div>
      <p className="muted small">{data ? sourceLine(data.source) : err ? "Couldn't load their open roles." : "Loading…"}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {data && data.source?.status === "active" && open.length === 0 && <p className="muted">No open roles in web, design, SEO, CRO or marketing right now.</p>}
      {open.length > 0 && (
        <ul>
          {open.map((p) => (
            <li key={p.id}>
              <a href={p.url} target="_blank" rel="noreferrer">{p.title} ↗</a>
              <span className="muted small"> · {ageLabel(p, now)}{p.location ? ` · ${p.location}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
