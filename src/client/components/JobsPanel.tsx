import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ageLabel, ROLE_KIND_LABEL, seenRecently, sourceLine } from "../jobsView";
import type { CareerSource, JobPosting } from "../types";
import Icon from "./Icon";
import { Badge } from "./Score";

interface Data { source: CareerSource | null; postings: JobPosting[] }

/** What the careers source is doing, as a badge: watching a board, nothing found, a failed read, or not looked at yet. */
function sourceBadge(s: CareerSource | null) {
  if (!s) return <Badge>Not checked</Badge>;
  if (s.status === "active") return <Badge tone="positive" dot>Watching</Badge>;
  if (s.status === "error") return <Badge tone="warning" dot>Can’t read</Badge>;
  return <Badge>No board</Badge>;
}

/** The lead page's Open roles card: roles in web, design, SEO, CRO or marketing that their own job board showed in the last two days. */
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
    <section className="section-card jobs-card" aria-label="Open roles">
      <header className="jc-head">
        <Icon name="briefcase" size={16} className="jc-icon" />
        <h3>Open roles</h3>
        {open.length > 0 && <span className="jc-count">{open.length}</span>}
        <span className="grow" />
        {data && sourceBadge(data.source)}
        <button type="button" className="btn sm" onClick={check} disabled={busy}><Icon name="refresh" size={14} />{busy ? "Checking…" : "Check now"}</button>
      </header>
      <p className="jc-sub">{data ? sourceLine(data.source) : err ? "Couldn't load their open roles." : "Loading…"}</p>
      {err && <p className="error" role="alert"><Icon name="alert" size={14} /> {err}</p>}
      {data && data.source?.status === "active" && open.length === 0 && <p className="jc-empty">No open roles in web, design, SEO, CRO or marketing right now.</p>}
      {open.length > 0 && (
        <ul className="jc-list">
          {open.map((p) => (
            <li key={p.id}>
              <a className="jc-title" href={p.url} target="_blank" rel="noreferrer">{p.title}<Icon name="arrow-up-right" size={12} /></a>
              <span className="jc-meta">{ageLabel(p, now)}{p.location ? ` · ${p.location}` : ""}</span>
              {p.role_kind && <Badge tone="outline">{ROLE_KIND_LABEL[p.role_kind]}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
