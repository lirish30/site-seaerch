import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { Badge } from "../components/Score";
import { ageLabel, ROLE_KIND_LABEL, type RoleKindKey } from "../jobsView";
import type { OpenRole } from "../types";

/** Open roles at your leads, read from their own job boards. Each row opens the posting; the company opens the lead. */
export default function Jobs() {
  const [jobs, setJobs] = useState<OpenRole[] | null>(null);
  const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [q, setQ] = useState(""); const [kind, setKind] = useState<"any" | RoleKindKey>("any");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<{ jobs: OpenRole[] }>("/jobs")
      .then((r) => { if (alive.current) setJobs(r.jobs); })
      .catch((e) => { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't load open roles."); });
  }, []);
  async function runNow() {
    setMsg(""); setErr("");
    try { await api.post("/jobs/run"); if (alive.current) setMsg("Checking boards in the background. Reload in a minute."); }
    catch (e) { if (alive.current) setErr(e instanceof ApiError ? e.message : "Couldn't start the check."); }
  }
  const now = new Date();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (jobs ?? []).filter((j) => (kind === "any" || j.role_kind === kind) && (!needle || `${j.title} ${j.business_name} ${j.location ?? ""}`.toLowerCase().includes(needle)));
  }, [jobs, q, kind]);
  const companies = new Set((jobs ?? []).map((j) => j.business_id)).size;
  const filtered = q.trim() !== "" || kind !== "any";
  const subtitle = !jobs ? "Loading…" : `${jobs.length} open ${jobs.length === 1 ? "role" : "roles"} at ${companies} ${companies === 1 ? "lead" : "leads"}`;

  return (
    <div className="jb-page">
      <header className="page-header">
        <div><h1>Jobs</h1><p>{subtitle}</p></div>
        <div className="header-actions"><button type="button" className="btn" onClick={runNow}><Icon name="refresh" size={16} />Check boards now</button></div>
      </header>
      <div className="page-body">
        <p className="jb-note">Roles in web, design, SEO, CRO and marketing at your leads, read from their own Greenhouse, Lever and Ashby boards. The check runs every six hours and each board is re-read about every 12 hours.</p>
        {err && <p className="error" role="alert"><Icon name="alert" size={14} /> {err}</p>}
        {msg && <p className="muted" role="status">{msg}</p>}
        {!jobs ? (err ? null : <p className="muted" role="status">Loading…</p>) : jobs.length === 0 ? (
          <div className="sh-empty"><h2>No open roles yet</h2><p>Boards are found for leads that have been scanned and have a careers page on a supported job board. Import a list of agencies or software companies to widen the net.</p>
            <Link to="/import" className="btn"><Icon name="upload" size={16} />Import leads</Link></div>
        ) : (
          <>
            <div className="table-tools">
              <label className="search-box"><Icon name="search" size={14} />
                <input type="search" placeholder="Search role, company or place…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search open roles" />
              </label>
              <label className={`filter${kind !== "any" ? " on" : ""}`}><span>Type</span>
                <select value={kind} onChange={(e) => setKind(e.target.value as "any" | RoleKindKey)} aria-label="Role type">
                  <option value="any">Any</option>{(Object.keys(ROLE_KIND_LABEL) as RoleKindKey[]).map((k) => <option key={k} value={k}>{ROLE_KIND_LABEL[k]}</option>)}
                </select><Icon name="chevron-down" size={14} /></label>
              {filtered && <button type="button" className="ghost" onClick={() => { setQ(""); setKind("any"); }}>Clear</button>}
            </div>
            <div className="jb-scroll"><div className="jb-table" role="table" aria-label="Open roles">
              <div className="jb-row jb-head" role="row">
                <span role="columnheader">Role</span><span role="columnheader">Company</span><span role="columnheader">Type</span><span role="columnheader">Age</span><span role="columnheader">Where</span>
              </div>
              {shown.map((j) => (
                <div key={j.id} className="jb-row" role="row">
                  <span role="cell" className="jb-role"><a href={j.url} target="_blank" rel="noreferrer">{j.title}<Icon name="arrow-up-right" size={12} /></a></span>
                  <span role="cell" className="jb-co"><Link to={`/leads/${j.business_id}`}>{j.business_name}</Link></span>
                  <span role="cell">{j.role_kind ? <Badge tone="outline">{ROLE_KIND_LABEL[j.role_kind]}</Badge> : <span className="sh-dash">—</span>}</span>
                  <span role="cell" className="jb-muted">{ageLabel(j, now)}</span>
                  <span role="cell" className="jb-muted">{j.location ?? "—"}</span>
                </div>
              ))}
              {shown.length === 0 && <div className="sh-none" role="row">No roles match these filters. <button type="button" className="link-btn" onClick={() => { setQ(""); setKind("any"); }}>Clear filters</button></div>}
            </div></div>
          </>
        )}
      </div>
    </div>
  );
}
