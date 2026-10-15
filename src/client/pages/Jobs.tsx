import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { ageLabel } from "../jobsView";
import type { OpenRole } from "../types";

export default function Jobs() {
  const [jobs, setJobs] = useState<OpenRole[] | null>(null);
  const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
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
  return (
    <div>
      <div className="row between page-head"><h2>Jobs</h2><button onClick={runNow}>Check boards now</button></div>
      <p className="muted">Open roles in web, design, SEO, CRO and marketing at your leads, read from their own job boards (Greenhouse, Lever, Ashby). Boards are checked every six hours.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p role="status">{msg}</p>}
      {!jobs ? (err ? null : <p role="status">Loading…</p>) : jobs.length === 0 ? (
        <div className="card"><p>No open roles yet. Boards are found for leads that have been scanned and have a careers page on a supported job board. Import a list of agencies or software companies to widen the net.</p></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Role</th><th>Company</th><th>Age</th><th>Where</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><a href={j.url} target="_blank" rel="noreferrer">{j.title} ↗</a></td>
                <td><Link to={`/leads/${j.business_id}`}>{j.business_name}</Link></td>
                <td className="muted">{ageLabel(j, now)}</td>
                <td className="muted">{j.location ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
