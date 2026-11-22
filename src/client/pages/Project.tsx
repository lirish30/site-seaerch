import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import ChangeOrdersPanel from "../components/ChangeOrdersPanel";
import ProjectBilling from "../components/ProjectBilling";
import ProjectSopTab from "../components/ProjectSopTab";
import TaskRow from "../components/TaskRow";
import { cancelConfirm, cancelLabel, kindLabel, milestoneChips, ownerBadge, phaseGroups, profitLines, projectProgress, projectState, stopControls, timeEstimate, timeRows, type Tone } from "../projectView";
import { formatMinutes, parseDuration, varianceLabel } from "../timeView";
import { announceProjectsChanged, TIMER_CHANGED, workError, type ProjectDetail, type RunningEntry } from "../workData";
import type { OwnerTag } from "../../worker/sop/model";

type Tab = "tasks" | "sop" | "time" | "change-orders" | "billing" | "profit";
const TABS: [Tab, string][] = [["tasks", "Tasks"], ["sop", "SOP"], ["time", "Time"], ["change-orders", "Change orders"], ["billing", "Billing"], ["profit", "Profit"]];
const POLL_MS = 20_000;
const TONE: Record<Tone, string> = { neutral: "outline", good: "positive", warn: "warning", muted: "" };
const isTab = (s: string | null): s is Tab => TABS.some(([k]) => k === s);

/** A project: its state and milestones, then Tasks, the SOP it came from (editable here), Time, Change orders, Billing and Profit. */
export default function ProjectPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const wanted = params.get("tab");
  const openTask = params.get("task");
  const tab: Tab = isTab(wanted) ? wanted : "tasks";
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [client, setClient] = useState("");
  const [running, setRunning] = useState<RunningEntry | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [pauseReason, setPauseReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.get<ProjectDetail>(`/projects/${id}`), api.get<{ entry: RunningEntry | null }>("/time/running").catch(() => ({ entry: null }))]);
      setData(d); setRunning(r.entry); setFailed(false);
    } catch { setFailed(true); }
  }, [id]);

  useEffect(() => {
    setData(null); setFailed(false); setError(""); setClient("");
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onTimer = () => void load();
    window.addEventListener(TIMER_CHANGED, onTimer);
    return () => { clearInterval(poll); window.removeEventListener(TIMER_CHANGED, onTimer); };
  }, [id, load]);

  const businessId = data?.project.businessId;
  useEffect(() => {
    if (!businessId) return;
    let live = true;
    api.get<{ business: { name: string } }>(`/leads/${businessId}`).then((x) => { if (live) setClient(x.business.name); }).catch(() => {});
    return () => { live = false; };
  }, [businessId]);

  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === "tasks") n.delete("tab"); else n.set("tab", t); n.delete("task"); return n; }, { replace: true });

  const patch = async (body: { status?: "active" | "paused" | "cancelled"; pausedReason?: string }, done?: () => void) => {
    setBusy(true); setError("");
    try { await api.patch(`/projects/${id}`, body); done?.(); await load(); announceProjectsChanged(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };

  if (failed && !data) return <div className="wk"><p className="error wk-body" role="alert">Couldn’t load this project. <Link to="/projects">Back to projects</Link></p></div>;
  if (!data) return <div className="wk"><p className="muted wk-body">Loading…</p></div>;

  const { project, tasks } = data;
  const state = projectState({ status: project.status, kind: project.kind, templateKey: project.templateKey, waitingOnClient: data.waitingOnClient });
  const progress = projectProgress(tasks);
  const stop = stopControls(project);
  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <p><Link to="/projects">Projects</Link></p>
          <h1>{project.name}</h1>
          <p>{client ? <Link to={`/leads/${project.businessId}`}>{client}</Link> : null}{client ? " · " : ""}{kindLabel(project.kind)}</p>
          <div className="wk-chips">
            <span className={`badge2 ${TONE[state.tone]}`}><i className="dot" />{state.label}</span>
            {project.test && <span className="badge2 info"><i className="dot" />Test</span>}
            {milestoneChips(data.milestones).map((m) => <span key={m.key} className={`badge2 ${m.reached ? "positive" : ""}`} title={m.reachedAt ? `Reached ${new Date(m.reachedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Not yet"}><i className="dot" />{m.label}{m.reached ? "" : ": not yet"}</span>)}
            {project.dealId && <Link className="small" to={`/deals/${project.dealId}`}>Deal</Link>}
          </div>
        </div>
        {(stop.pause || stop.resume || stop.cancel) && (
          <div className="header-actions">
            {stop.pause && <button type="button" className="btn" disabled={busy} aria-expanded={pausing} onClick={() => setPausing((p) => !p)}>Pause</button>}
            {stop.resume && <button type="button" className="btn primary" disabled={busy} onClick={() => void patch({ status: "active" })}>Resume</button>}
            {stop.cancel && <button type="button" className="btn" disabled={busy} onClick={() => { if (window.confirm(cancelConfirm(project.name, stop.cancel!))) void patch({ status: "cancelled" }); }}>{cancelLabel(stop.cancel)}</button>}
          </div>
        )}
      </header>
      <div className="wk-body">
        {project.status === "paused" && project.pausedReason && <p className="warn small" role="status">Paused: {project.pausedReason}</p>}
        {data.waitingOnClient && <p className="muted small" role="status">The client has gone quiet on the onboarding, so no Claude step starts until they write back.</p>}
        {pausing && project.status === "active" && (
          <div className="wk-inline">
            <label className="deal-field"><span>Why pause it? (optional)</span><input value={pauseReason} maxLength={300} onChange={(e) => setPauseReason(e.target.value)} /></label>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void patch({ status: "paused", pausedReason: pauseReason.trim() || undefined }, () => { setPausing(false); setPauseReason(""); })}>Pause project</button>
          </div>
        )}
        {error && <p className="warn small" role="alert">{error}</p>}
        <div className="wk-progress" role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
          <span className="wk-bar"><i style={{ width: `${progress.pct}%` }} /></span>
          <span className="small muted">{progress.done} of {progress.total} done</span>
        </div>
        <div className="seg-pills wk-tabs" role="group" aria-label="Project sections">
          {TABS.map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>

        {tab === "tasks" && <TasksTab data={data} runningTaskId={running?.taskId ?? null} openTask={openTask} onChange={load} />}
        {tab === "sop" && <ProjectSopTab data={data} onChanged={load} />}
        {tab === "time" && <TimeTab data={data} />}
        {tab === "change-orders" && <ChangeOrdersPanel projectId={project.id} changeOrders={data.changeOrders} projectStatus={project.status} onChanged={load} />}
        {tab === "billing" && <ProjectBilling projectId={project.id} changeOrders={data.changeOrders} />}
        {tab === "profit" && (
          <section className="card wk-profit" aria-label="Profit">
            <h3>Profit</h3>
            {profitLines(data.profit, data.costRateCentsPerHour).map((l) => <p key={l}>{l}</p>)}
            <p className="muted small">Time at your cost rate against what the client has paid. Paid change orders count.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function TasksTab({ data, runningTaskId, openTask, onChange }: { data: ProjectDetail; runningTaskId: string | null; openTask: string | null; onChange: () => Promise<void> }) {
  const { project, tasks } = data;
  const groups = phaseGroups(tasks);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<OwnerTag>("logan");
  const [est, setEst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const estMinutes = est.trim() ? parseDuration(est) : 0;
  const add = async () => {
    setBusy(true); setError("");
    try { await api.post(`/projects/${project.id}/tasks`, { title, owner, estMinutes: estMinutes ?? 0 }); setTitle(""); setEst(""); await onChange(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  return (
    <>
      {groups.length === 0 && <p className="muted">No tasks yet.</p>}
      {groups.map((g) => (
        <section key={g.phaseKey} className="wk-phase" aria-label={g.title}>
          <h3>{g.title}<span className="wk-count">{g.done}/{g.total}</span></h3>
          <ul className="wk-tasks">
            {g.tasks.map((t) => <TaskRow key={t.id} task={t} all={tasks} actualMinutes={data.taskMinutes[t.id] ?? 0} runningTaskId={runningTaskId} projectStatus={project.status} startOpen={openTask === t.id} onChange={onChange} />)}
          </ul>
        </section>
      ))}
      {project.status !== "cancelled" && (
        <details className="wk-add">
          <summary>Add a task</summary>
          <div className="wk-inline">
            <label className="deal-field"><span>What needs doing</span><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="deal-field"><span>Who does it</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value as OwnerTag)}>{(["logan", "claude", "claude_drafts"] as OwnerTag[]).map((o) => <option key={o} value={o}>{ownerBadge(o)}</option>)}</select></label>
            <label className="deal-field"><span>Estimate (like 45m or 1:30)</span><input value={est} inputMode="text" onChange={(e) => setEst(e.target.value)} aria-invalid={estMinutes === null} /></label>
            <button type="button" className="btn primary" disabled={busy || !title.trim() || estMinutes === null} onClick={() => void add()}>Add task</button>
          </div>
          {error && <p className="warn small" role="alert">{error}</p>}
        </details>
      )}
    </>
  );
}

function TimeTab({ data }: { data: ProjectDetail }) {
  const est = timeEstimate(data.tasks, data.taskMinutes);
  const rows = timeRows(data.tasks, data.taskMinutes);
  return (
    <section aria-label="Time">
      <p><b>{formatMinutes(data.time.actualMinutes)}</b> logged, {formatMinutes(data.time.billableMinutes)} billable. Estimate for the work started: {est > 0 ? formatMinutes(est) : "none"}{est > 0 ? ` (${varianceLabel(est, data.time.actualMinutes)})` : ""}.</p>
      {rows.length === 0 ? <p className="muted">No time logged yet. Start a timer on a task, or add time on the <Link to="/timesheet">timesheet</Link>.</p> : (
        <ul className="wk-list">
          {rows.map((t) => {
            const actual = data.taskMinutes[t.id] ?? 0;
            return (
              <li key={t.id} className="wk-row">
                <span className="wk-row-main">{t.title}</span>
                <span>{formatMinutes(actual)}{t.estMinutes > 0 ? ` of ${formatMinutes(t.estMinutes)}` : ""}</span>
                <span className="muted small">{varianceLabel(t.estMinutes, actual)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
