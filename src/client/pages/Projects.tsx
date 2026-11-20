import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { kindLabel, projectBucket, projectState, type Bucket, type Tone } from "../projectView";
import { PROJECTS_CHANGED, type MyTasks, type ProjectRow } from "../workData";

const TONE: Record<Tone, string> = { neutral: "outline", good: "positive", warn: "warning", muted: "" };
const VIEWS: Record<Bucket, { title: string; blurb: string; empty: string }> = {
  active: { title: "Active projects", blurb: "Work in progress, newest first.", empty: "No active projects. One starts by itself when a client’s deposit is paid." },
  waiting: { title: "Waiting on client", blurb: "The client has gone quiet on the onboarding, so no Claude step starts until they write back.", empty: "No project is waiting on a client." },
  paused: { title: "Paused", blurb: "On hold until you resume them.", empty: "Nothing is paused." },
  done: { title: "Done", blurb: "Finished and cancelled projects.", empty: "Nothing is finished yet." },
};
const isBucket = (s: string | null): s is Bucket => s === "active" || s === "waiting" || s === "paused" || s === "done";

/** Every project as a card: the client, what kind, how far along, the next step for you, and its state. The view (Active, Waiting on client, Paused, Done) comes from the sidebar. */
export default function Projects() {
  const [params] = useSearchParams();
  const wanted = params.get("view");
  const view: Bucket = isBucket(wanted) ? wanted : "active";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [next, setNext] = useState<Map<string, string>>(new Map());
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    api.get<{ projects: ProjectRow[] }>("/projects").then((r) => setRows(r.projects)).catch(() => { setRows(null); setFailed(true); });
    // The first step waiting on Logan in each project; a project with none is simply without the line.
    api.get<MyTasks>("/me/tasks").then((r) => setNext(new Map(r.projects.filter((p) => p.tasks.length).map((p) => [p.projectId, p.tasks[0].title])))).catch(() => setNext(new Map()));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => window.removeEventListener(PROJECTS_CHANGED, load);
  }, [load]);

  const shown = (rows ?? []).filter((p) => projectBucket(p) === view);
  const v = VIEWS[view];
  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>{v.title}</h1>
          <p>{v.blurb}</p>
        </div>
        <div className="header-actions">
          <Link to="/timesheet" className="btn"><Icon name="clock" size={16} />Timesheet</Link>
          <button type="button" className="btn" onClick={load}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="wk-body">
        {failed && <p className="error" role="alert">Couldn’t load the projects. <button type="button" className="btn" onClick={load}>Try again</button></p>}
        {!failed && rows === null && <p className="muted">Loading…</p>}
        {rows !== null && shown.length === 0 && <p className="muted">{v.empty}</p>}
        <ul className="wk-cards">
          {shown.map((p) => {
            const state = projectState(p);
            const total = p.openTasks + p.doneTasks;
            const pct = total ? Math.round((p.doneTasks / total) * 100) : 0;
            const mine = next.get(p.id);
            return (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="wk-card">
                  <span className="wk-card-top">
                    <strong>{p.name}</strong>
                    <span className="wk-chips">
                      {p.test && <span className="badge2 info"><i className="dot" />Test</span>}
                      <span className={`badge2 ${TONE[state.tone]}`}><i className="dot" />{state.label}</span>
                    </span>
                  </span>
                  <span className="muted small">{p.businessName} · {kindLabel(p.kind)}</span>
                  <span className="wk-progress">
                    <span className="wk-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                    <span className="small muted">{p.doneTasks} of {total} done</span>
                  </span>
                  {p.status === "active" && <span className="small">{mine ? <>Next for you: {mine}</> : <span className="muted">Nothing waiting on you</span>}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
