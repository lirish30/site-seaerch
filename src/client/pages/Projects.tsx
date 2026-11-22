import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { EmptyState, StatRow } from "../components/PageBits";
import { bucketCounts, kindLabel, listProgress, projectState, visibleProjects, type Bucket, type Tone } from "../projectView";
import { projectIsLive } from "../../worker/db/projects";
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
  const lead = params.get("businessId");
  const view: Bucket = isBucket(wanted) ? wanted : "active";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [next, setNext] = useState<Map<string, string>>(new Map());
  const [mineCount, setMineCount] = useState(0);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    api.get<{ projects: ProjectRow[] }>("/projects").then((r) => setRows(r.projects)).catch(() => { setRows(null); setFailed(true); });
    // The first step waiting on Logan in each project; a project with none is simply without the line.
    api.get<MyTasks>("/me/tasks").then((r) => { setNext(new Map(r.projects.filter((p) => p.tasks.length).map((p) => [p.projectId, p.tasks[0].title]))); setMineCount(r.projects.reduce((n, p) => n + p.tasks.length, 0)); }).catch(() => setNext(new Map()));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => window.removeEventListener(PROJECTS_CHANGED, load);
  }, [load]);

  const shown = visibleProjects(rows ?? [], { view, businessId: lead });
  const v = lead ? { title: `Projects for ${shown[0]?.businessName ?? "this client"}`, blurb: "Every project for this client, whatever its state.", empty: "This client has no projects." } : VIEWS[view];
  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>{v.title}</h1>
          <p>{v.blurb}</p>
        </div>
        <div className="header-actions">
          {lead && <Link to="/projects" className="btn">All projects</Link>}
          <Link to="/timesheet" className="btn"><Icon name="clock" size={16} />Timesheet</Link>
          <button type="button" className="btn" onClick={load}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="pb-page">
        {failed && <p className="error" role="alert">Couldn’t load the projects. <button type="button" className="btn" onClick={load}>Try again</button></p>}
        {!failed && rows === null && <p className="muted">Loading…</p>}
        {rows !== null && !lead && (() => {
          const c = bucketCounts(rows);
          return <StatRow stats={[
            { label: "Active", value: c.active, sub: c.active ? "Projects being worked" : "None running" },
            { label: "Steps on you", value: mineCount, sub: mineCount ? "Open them from each card" : "Nothing waiting on you", tone: mineCount ? "warning" : "positive" },
            { label: "Waiting on client", value: c.waiting, sub: c.waiting ? "Gone quiet on onboarding" : "Nobody is holding you up", tone: c.waiting ? "warning" : "" },
            { label: "Done", value: c.done, sub: c.paused ? `${c.paused} paused` : "Finished or cancelled" },
          ]} />;
        })()}
        {rows !== null && shown.length === 0 && (view === "active" && !lead ? (
          <EmptyState icon="briefcase" title="No active projects"
            steps={[
              { title: "A client signs", text: "The proposal names the package, and the package names its SOP.", to: "/pipeline" },
              { title: "The deposit is paid", text: "The project starts by itself with every task from the SOP." },
              { title: "You and Claude work it", text: "Your steps show here as Next for you; Claude's run from the queue." },
            ]}>
            A project starts by itself when a client's deposit is paid.
          </EmptyState>
        ) : <EmptyState icon={view === "done" ? "check" : view === "paused" ? "ban" : "clock"} title={v.empty} />)}
        <ul className="wk-cards">
          {shown.map((p) => {
            const state = projectState(p);
            const { done, total, pct } = listProgress(p);
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
                    <span className="small muted">{done} of {total} done</span>
                  </span>
                  {projectIsLive(p) && <span className={`wk-next small${mine ? " on" : ""}`}>{mine ? <><Icon name="arrow-right" size={14} /><span>Next for you: <b>{mine}</b></span></> : <span className="muted">Nothing waiting on you</span>}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
