import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import ChangeOrdersPanel from "../components/ChangeOrdersPanel";
import { Banner, Card, Chip, Empty, Meter, PageHeader, Score, Stat, Stats, Tabs } from "../components/ds";
import Icon from "../components/Icon";
import ProjectBilling from "../components/ProjectBilling";
import ProjectSopTab from "../components/ProjectSopTab";
import TaskRow, { RowMenu, TimerBanner } from "../components/TaskRow";
import { dollars } from "../packagesView";
import {
  cancelConfirm, cancelLabel, currentPhase, groupByClient, kindChip, kindLabel, milestoneChips, minutesByPhase, ownerBadge, pagerOf, phaseGroups, phaseState, projectBucket,
  projectProgress, shortDate, statusChip, stopControls, timeEstimate, timeRows, totalEstimate,
} from "../projectView";
import { formatMinutes, parseDuration, varianceLabel } from "../timeView";
import { announceProjectsChanged, TIMER_CHANGED, workError, type ProjectDetail, type ProjectRow, type RunningEntry } from "../workData";
import type { OwnerTag } from "../../worker/sop/model";

type Tab = "tasks" | "sop" | "time" | "change-orders" | "billing" | "profit";
const TAB_KEYS: Tab[] = ["tasks", "sop", "time", "change-orders", "billing", "profit"];
const POLL_MS = 20_000;
const isTab = (s: string | null): s is Tab => TAB_KEYS.some((k) => k === s);
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** A project: its header (client, kind, state, what to do next), then Tasks (phases you open and close, with Progress, Waiting on client and Time beside them), SOP, Time, Change orders, Billing and Profit. */
export default function ProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const wanted = params.get("tab");
  const openTask = params.get("task");
  const tab: Tab = isTab(wanted) ? wanted : "tasks";
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [client, setClient] = useState("");
  const [running, setRunning] = useState<RunningEntry | null>(null);
  const [siblings, setSiblings] = useState<ProjectRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.get<ProjectDetail>(`/projects/${id}`), api.get<{ entry: RunningEntry | null }>("/time/running").catch(() => ({ entry: null }))]);
      setData(d); setRunning(r.entry); setFailed(false);
    } catch { setFailed(true); }
  }, [id]);

  useEffect(() => {
    setData(null); setFailed(false); setError(""); setClient(""); setAdding(false); setPausing(false);
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onTimer = () => void load();
    window.addEventListener(TIMER_CHANGED, onTimer);
    return () => { clearInterval(poll); window.removeEventListener(TIMER_CHANGED, onTimer); };
  }, [id, load]);

  // The projects list, for the "3 of 9" pager: the same list (Active, Waiting, Paused, Done) this project sits in, in the list's order.
  useEffect(() => {
    let live = true;
    api.get<{ projects: ProjectRow[] }>("/projects").then((r) => { if (live) setSiblings(r.projects); }).catch(() => {});
    return () => { live = false; };
  }, []);

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

  if (failed && !data) {
    return <div className="ds-page wkx"><div className="ds-body"><div className="ds-card"><Empty icon="alert" title="Couldn’t load this project" action={<Link to="/projects" className="btn">Back to projects</Link>}>It may have been removed, or the connection dropped. Try again in a moment.</Empty></div></div></div>;
  }
  if (!data) return <div className="ds-page wkx"><div className="ds-body"><p className="muted">Loading…</p></div></div>;

  const { project, tasks } = data;
  const row = { ...project, waitingOnClient: data.waitingOnClient };
  const kind = kindChip(project);
  const status = statusChip(row);
  const stop = stopControls(project);
  const steps = tasks.filter((t) => t.isStep);
  const name = client || siblings.find((s) => s.businessId === project.businessId)?.businessName || "";
  const bucket = projectBucket(row);
  const list = groupByClient(siblings.filter((s) => projectBucket(s) === bucket)).flatMap((g) => g.rows);
  const pager = pagerOf(list, project.id);
  const canAdd = project.status !== "cancelled";
  const timerHere = running && running.projectId === project.id ? running : null;

  const openAdd = () => { setTab("tasks"); setAdding(true); };
  const menu = (project.kind === "build" || stop.pause || stop.cancel || (stop.resume && canAdd)) && (
    <RowMenu label="More actions" summary={<><Icon name="more" size={16} />More</>} className="wkx-head-menu">
      {(close) => (
        <>
          {project.kind === "build" && <a className="wkx-menu-link" href={`/api/projects/${id}/kickoff-deck.pdf`} download onClick={close}><Icon name="file-text" size={14} />Download the kickoff deck</a>}
          {stop.resume && canAdd && <button type="button" role="menuitem" onClick={() => { close(); openAdd(); }}>Add a task</button>}
          {stop.pause && <button type="button" role="menuitem" disabled={busy} onClick={() => { close(); setPausing(true); }}>Pause the project…</button>}
          {stop.cancel && <button type="button" role="menuitem" className="wkx-danger" disabled={busy} onClick={() => { close(); if (window.confirm(cancelConfirm(project.name, stop.cancel!))) void patch({ status: "cancelled" }); }}>{cancelLabel(stop.cancel)}</button>}
        </>
      )}
    </RowMenu>
  );
  const primary = stop.resume
    ? <button type="button" className="btn primary" disabled={busy} onClick={() => void patch({ status: "active" })}><Icon name="zap" size={16} />Resume the project</button>
    : canAdd ? <button type="button" className="btn primary" onClick={openAdd}><Icon name="plus" size={16} />Add task</button> : null;

  const meta: { icon: "building" | "briefcase" | "calendar" | "file-text" | "link"; text: ReactNode }[] = [];
  if (name) meta.push({ icon: "building", text: <Link to={`/clients/${project.businessId}`}>{name}</Link> });
  meta.push({ icon: "briefcase", text: kindLabel(project.kind) });
  meta.push({ icon: "calendar", text: project.status === "done" && project.completedAt ? `Started ${dateOf(project.startedAt)} · finished ${dateOf(project.completedAt)}` : `Started ${dateOf(project.startedAt)}` });
  if (data.template) meta.push({ icon: "file-text", text: `From the ${data.template.name} SOP` });
  if (project.dealId) meta.push({ icon: "link", text: <Link to={`/deals/${project.dealId}`}>Open the deal</Link> });

  return (
    <div className="ds-page wkx">
      <PageHeader
        crumbs={[{ label: "Projects", to: "/projects" }, ...(name ? [{ label: name, to: `/projects?businessId=${encodeURIComponent(project.businessId)}` }] : []), { label: project.name }]}
        pager={pager ? { label: `${pager.index} of ${pager.total}`, prev: pager.prev ? () => navigate(`/projects/${pager.prev!.id}`) : undefined, next: pager.next ? () => navigate(`/projects/${pager.next!.id}`) : undefined } : undefined}
        avatar={name || project.name}
        title={project.name}
        chips={<><Chip tone={kind.tone}>{kind.label}</Chip>{project.test && <Chip tone="info">Test</Chip>}<Chip tone={status.tone} dot>{status.label}</Chip></>}
        meta={meta}
        actions={<>{menu}{primary}</>}
        tabs={<Tabs label="Project sections" value={tab} onChange={setTab} tabs={[
          { key: "tasks", label: "Tasks", count: tasks.length || undefined },
          { key: "sop", label: "SOP", count: steps.length || undefined },
          { key: "time", label: "Time", count: data.time.actualMinutes > 0 ? `${Math.round(data.time.actualMinutes / 6) / 10} h` : undefined },
          { key: "change-orders", label: "Change orders", count: data.changeOrders.length || undefined },
          { key: "billing", label: "Billing" },
          { key: "profit", label: "Profit" },
        ]} />}
      />
      <div className="ds-body">
        {project.status === "paused" && (
          <Banner tone="warning" icon="ban" title={project.pausedReason ? `Paused: ${project.pausedReason}` : "This project is paused"}
            action={<button type="button" className="btn primary sm" disabled={busy} onClick={() => void patch({ status: "active" })}>Resume</button>}>
            Nothing moves and no Claude step starts until you resume it.
          </Banner>
        )}
        {timerHere && <TimerBanner entry={timerHere} onStopped={() => void load()} />}
        {pausing && project.status === "active" && (
          <Card icon="ban" title="Pause this project" note="Claude steps stop until you resume">
            <div className="wk-inline">
              <label className="deal-field"><span>Why pause it? (optional, shown on the projects list)</span><input value={pauseReason} maxLength={300} autoFocus onChange={(e) => setPauseReason(e.target.value)} /></label>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void patch({ status: "paused", pausedReason: pauseReason.trim() || undefined }, () => { setPausing(false); setPauseReason(""); })}>Pause project</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setPausing(false)}>Cancel</button>
            </div>
          </Card>
        )}
        {error && <p className="warn small" role="alert">{error}</p>}

        {tab === "tasks" && <TasksTab data={data} runningTaskId={running?.taskId ?? null} openTask={openTask} adding={adding} setAdding={setAdding} onChange={load} openTime={() => setTab("time")} />}
        {tab === "sop" && <ProjectSopTab data={data} onChanged={load} />}
        {tab === "time" && <TimeTab data={data} />}
        {tab === "change-orders" && <ChangeOrdersPanel projectId={project.id} changeOrders={data.changeOrders} projectStatus={project.status} onChanged={load} />}
        {tab === "billing" && <ProjectBilling projectId={project.id} changeOrders={data.changeOrders} />}
        {tab === "profit" && <ProfitTab data={data} />}
      </div>
    </div>
  );
}

function TasksTab({ data, runningTaskId, openTask, adding, setAdding, onChange, openTime }: {
  data: ProjectDetail; runningTaskId: string | null; openTask: string | null; adding: boolean; setAdding: (b: boolean) => void; onChange: () => Promise<void>; openTime: () => void;
}) {
  const { project, tasks } = data;
  const groups = phaseGroups(tasks);
  const progress = projectProgress(tasks);
  const linked = openTask ? tasks.find((t) => t.id === openTask)?.phaseKey ?? null : null;
  const [openPhases, setOpenPhases] = useState<Set<string>>(() => new Set([currentPhase(groups), linked].filter((k): k is string => !!k)));
  useEffect(() => { if (linked) setOpenPhases((s) => (s.has(linked) ? s : new Set([...s, linked]))); }, [linked]);
  const toggle = (k: string) => setOpenPhases((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const waiting = tasks.filter((t) => t.status === "waiting_client");
  const est = totalEstimate(tasks);
  const phases = minutesByPhase(tasks, data.taskMinutes);
  const milestones = milestoneChips(data.milestones);

  return (
    <div className="ds-cols c2 wkx-project-cols">
      <div className="ds-col">
        {adding && <AddTask projectId={project.id} onDone={async () => { setAdding(false); await onChange(); }} onCancel={() => setAdding(false)} />}
        {groups.length === 0 ? (
          <div className="ds-card"><Empty icon="list" title="No tasks yet" action={project.status !== "cancelled" && !adding ? <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add task</button> : undefined}>
            A project's tasks come from the SOP for its package. Add one by hand for anything extra.</Empty></div>
        ) : (
          <div className="wkx-phases">
            {groups.map((g, i) => {
              const isOpen = openPhases.has(g.phaseKey);
              const st = phaseState(g);
              return (
                <section key={g.phaseKey} className={`wkx-phase${isOpen ? " open" : ""}`} aria-label={g.title}>
                  <button type="button" className="wkx-phase-head" aria-expanded={isOpen} onClick={() => toggle(g.phaseKey)}>
                    <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} />
                    <b>{i + 1} · {g.title}</b>
                    <span className="ds-grow" />
                    <small>{g.done} of {g.total}</small>
                    <Meter value={g.done} max={g.total} tone={g.done === g.total ? "positive" : "signal"} width={80} label={`${g.done} of ${g.total} done`} />
                    {st ? <Chip tone={st.tone} dot={st.label !== "Done"}>{st.label}</Chip> : <span className="wkx-chip-space" />}
                  </button>
                  {isOpen && (
                    <ul className="wkx-tasks">
                      {g.tasks.map((t) => <TaskRow key={t.id} task={t} all={tasks} actualMinutes={data.taskMinutes[t.id] ?? 0} runningTaskId={runningTaskId} projectStatus={project.status} startOpen={openTask === t.id} onChange={onChange} />)}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="ds-col">
        <Card icon="gauge" title="Progress">
          <Score value={`${progress.pct}%`} unit={`${progress.done} of ${progress.total} ${progress.total === 1 ? "step" : "steps"}`} meter={{ value: progress.done, max: progress.total, tone: progress.pct === 100 ? "positive" : "signal" }}
            reasons={project.kind === "build" || data.milestones.length ? milestones.map((m) => ({ ok: m.reached ? true : null, text: m.reached && m.reachedAt ? `${m.label} ${dateOf(m.reachedAt)}` : `${m.label}: not yet` })) : undefined} />
          <p className="wkx-card-foot">Done and skipped steps count. Step-by-step work Claude does shows up in your approvals.</p>
        </Card>

        {(waiting.length > 0 || data.waitingOnClient) && (
          <Card icon="clock" title="Waiting on client" action={waiting.length > 0 ? <Chip tone="warning">{waiting.length} {waiting.length === 1 ? "item" : "items"}</Chip> : undefined}>
            {waiting.length > 0 && (
              <ul className="wkx-waiting">
                {waiting.map((t) => (
                  <li key={t.id}><b>{t.title}</b><small>{t.dueOn ? `Due ${shortDate(t.dueOn)} · ` : ""}waiting since {dateOf(t.updatedAt)}</small></li>
                ))}
              </ul>
            )}
            {data.waitingOnClient && <p>The client has gone quiet on the onboarding, so no Claude step starts until they write back.</p>}
            {waiting.length > 0 && <p className="wkx-card-foot">When they reply, open the task's More menu and pick Back to work.</p>}
          </Card>
        )}

        <Card icon="clock" title="Time" note={est > 0 ? `Estimate ${Math.round(est / 6) / 10} h` : "No estimate"}>
          <Score size="md" value={`${Math.round(data.time.actualMinutes / 6) / 10} h`} unit={`logged · ${formatMinutes(data.time.billableMinutes)} billable`}
            meter={est > 0 ? { value: data.time.actualMinutes, max: est, tone: data.time.actualMinutes > est ? "warning" : "neutral" } : undefined} />
          {phases.length > 0 ? (
            <dl className="wkx-lines">{phases.map((p) => <div key={p.phaseKey}><dt>{p.title}</dt><dd>{(p.minutes / 60).toFixed(1)} h</dd></div>)}</dl>
          ) : <p>No time logged yet. Start a timer from a task's More menu, or add time on the timesheet.</p>}
          <button type="button" className="btn sm wkx-wide" onClick={openTime}>See time by task</button>
        </Card>
      </div>
    </div>
  );
}

function AddTask({ projectId, onDone, onCancel }: { projectId: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<OwnerTag>("logan");
  const [est, setEst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const estMinutes = est.trim() ? parseDuration(est) : 0;
  const add = async () => {
    setBusy(true); setError("");
    try { await api.post(`/projects/${projectId}/tasks`, { title, owner, estMinutes: estMinutes ?? 0 }); setTitle(""); setEst(""); await onDone(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  return (
    <Card icon="plus" title="Add a task" note="It goes in its own Extra tasks phase">
      <form className="wk-inline" onSubmit={(e) => { e.preventDefault(); if (title.trim() && estMinutes !== null) void add(); }}>
        <label className="deal-field wkx-grow2"><span>What needs doing</span><input value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="deal-field"><span>Who does it</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value as OwnerTag)}>{(["logan", "claude", "claude_drafts"] as OwnerTag[]).map((o) => <option key={o} value={o}>{ownerBadge(o)}</option>)}</select></label>
        <label className="deal-field"><span>Estimate (like 45m or 1:30)</span><input value={est} inputMode="text" onChange={(e) => setEst(e.target.value)} aria-invalid={estMinutes === null} /></label>
        <button type="submit" className="btn primary" disabled={busy || !title.trim() || estMinutes === null}>Add task</button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </form>
      {error && <p className="warn small" role="alert">{error}</p>}
    </Card>
  );
}

function TimeTab({ data }: { data: ProjectDetail }) {
  const est = timeEstimate(data.tasks, data.taskMinutes);
  const rows = timeRows(data.tasks, data.taskMinutes);
  const nonBillable = Math.max(0, data.time.actualMinutes - data.time.billableMinutes);
  return (
    <>
      <Stats label="Time on this project">
        <Stat icon="clock" label="Logged" value={formatMinutes(data.time.actualMinutes)} sub={data.time.actualMinutes ? "Every timer and hand entry on its tasks" : "Nothing logged yet"} />
        <Stat icon="card" label="Billable" value={formatMinutes(data.time.billableMinutes)} sub={nonBillable ? `${formatMinutes(nonBillable)} not billable` : "All of it can be billed"} />
        <Stat icon="gauge" label="Against the estimate" value={est > 0 ? varianceLabel(est, data.time.actualMinutes) : "No estimate"}
          sub={est > 0 ? `${formatMinutes(est)} estimated for the work started` : "Only started tasks count"} tone={est > 0 && data.time.actualMinutes > est ? "warning" : undefined} />
      </Stats>
      {rows.length === 0 ? (
        <div className="ds-card"><Empty icon="clock" title="No time logged yet" action={<Link to="/timesheet" className="btn">Open the timesheet</Link>}>Start a timer from a task's More menu, or add time by hand on the timesheet. It shows here by task.</Empty></div>
      ) : (
        <Card icon="list" title="Time by task" note={`${rows.length} ${rows.length === 1 ? "task" : "tasks"}`} flush>
          <div className="wkx-scroll">
            <table className="ds-table">
              <thead><tr><th scope="col">Task</th><th scope="col">Phase</th><th scope="col" className="num">Logged</th><th scope="col" className="num">Estimate</th><th scope="col">Against estimate</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const actual = data.taskMinutes[t.id] ?? 0;
                  const v = varianceLabel(t.estMinutes, actual);
                  return (
                    <tr key={t.id}>
                      <th scope="row"><Link className="wkx-proj-name" to={`/projects/${t.projectId}?task=${t.id}`}>{t.title}</Link></th>
                      <td>{t.phaseTitle}</td>
                      <td className="num">{formatMinutes(actual)}</td>
                      <td className="num">{t.estMinutes > 0 ? formatMinutes(t.estMinutes) : "–"}</td>
                      <td><Chip tone={v.endsWith("over") ? "warning" : v === "no estimate" ? "neutral" : "positive"}>{v}</Chip></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function ProfitTab({ data }: { data: ProjectDetail }) {
  const p = data.profit;
  const noRate = data.costRateCentsPerHour === 0;
  return (
    <>
      <Stats label="Profit">
        <Stat icon="tag" label="Sold" value={dollars(p.soldCents)} sub="The price agreed, with signed change orders" />
        <Stat icon="card" label="Paid so far" value={dollars(p.paidCents)} sub={p.soldCents ? `${Math.round((p.paidCents / p.soldCents) * 100)}% of what was sold` : "Nothing sold yet"} />
        <Stat icon="clock" label="Cost of your time" value={noRate ? "Not set" : dollars(p.costCents)} sub={noRate ? "Set it in Settings, Work" : `At ${dollars(data.costRateCentsPerHour)} an hour`} tone={noRate ? "warning" : undefined} />
        <Stat icon="trending" label="Margin on what is paid" value={noRate ? "–" : dollars(p.marginPaidCents)}
          sub={noRate ? "Needs a cost rate" : p.effectiveHourlyCents === null ? "No time logged yet" : `About ${dollars(p.effectiveHourlyCents)} an hour`} tone={!noRate && p.marginPaidCents < 0 ? "critical" : !noRate ? "positive" : undefined} />
      </Stats>
      <p className="wkx-foot-note"><Icon name="info" size={14} />Time at your cost rate against what the client has paid. Paid change orders count. {noRate && <Link to="/settings/work">Set your cost rate</Link>}</p>
    </>
  );
}
