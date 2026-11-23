import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Card, Chip, Empty, Meter, Note, PageHeader, Stat, Stats } from "../components/ds";
import Icon from "../components/Icon";
import { TimerBanner } from "../components/TaskRow";
import { decimalHours, statusChip } from "../projectView";
import { dayLabel, formatMinutes, parseDuration, shiftDay, todayIn, weekLabel, weekSummary } from "../timeView";
import type { Capacity } from "../../worker/capacity/compute";
import { TIMER_CHANGED, workError, type MyTasks, type ProjectDetail, type ProjectRow, type RunningEntry, type Week } from "../workData";

interface Option { taskId: string; label: string; project: string }
interface ProjectInfo { status: { label: string; tone: "neutral" | "outline" | "positive" | "warning" | "critical" | "info" | "signal" } | null; est: Map<string, number> }

/**
 * The week as a grid: tasks grouped by client and project, a soft chip for each day's time (today's column tinted), totals on the right and below.
 * Add time opens a small form at the top (tapping a day cell opens it on that task and day). A running timer shows as a banner with Stop.
 */
export default function Timesheet() {
  // null is "this week": the server picks today in your time zone.
  const [of, setOf] = useState<string | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [mine, setMine] = useState<Option[]>([]);
  const [running, setRunning] = useState<RunningEntry | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [info, setInfo] = useState<Map<string, ProjectInfo>>(new Map());
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [day, setDay] = useState("");
  const [length, setLength] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lengthBox = useRef<HTMLInputElement>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  useEffect(() => { api.get<{ capacity: Capacity | null }>("/today").then((r) => setCapacity(r.capacity)).catch(() => setCapacity(null)); }, []);
  useEffect(() => { api.get<{ projects: ProjectRow[] }>("/projects").then((r) => setProjects(r.projects)).catch(() => setProjects([])); }, []);

  const load = useCallback(() => {
    setFailed(false);
    api.get<Week>(`/time/week${of ? `?of=${of}` : ""}`).then((w) => { setWeek(w); setDay((d) => (w.days.includes(d) ? d : w.days[0])); }).catch(() => setFailed(true));
    api.get<{ entry: RunningEntry | null }>("/time/running").then((r) => setRunning(r.entry)).catch(() => setRunning(null));
  }, [of]);
  useEffect(() => {
    load();
    window.addEventListener(TIMER_CHANGED, load);
    return () => window.removeEventListener(TIMER_CHANGED, load);
  }, [load]);
  useEffect(() => {
    api.get<MyTasks>("/me/tasks").then((r) => setMine(r.projects.flatMap((p) => p.tasks.map((t) => ({ taskId: t.id, label: t.title, project: p.projectName }))))).catch(() => setMine([]));
  }, []);

  // Each project in the week, read once: its client, whether it is paused, and the estimate of each task (for the Est. column).
  const projectIds = [...new Set((week?.rows ?? []).map((r) => r.projectId))].sort().join(",");
  useEffect(() => {
    if (!projectIds) return;
    let live = true;
    const ids = projectIds.split(",").filter((id) => !info.has(id));
    Promise.all(ids.map((id) => api.get<ProjectDetail>(`/projects/${id}`).then((d) => [id, d] as const).catch(() => null))).then((list) => {
      if (!live) return;
      setInfo((old) => {
        const next = new Map(old);
        for (const x of list) {
          if (!x) continue;
          const [id, d] = x;
          const s = statusChip({ ...d.project, waitingOnClient: d.waitingOnClient });
          next.set(id, { status: d.project.status === "paused" || d.project.status === "cancelled" ? s : null, est: new Map(d.tasks.map((t) => [t.id, t.estMinutes])) });
        }
        return next;
      });
    });
    return () => { live = false; };
    // info is read only to skip projects already loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds]);

  // The tasks you can add time to: the ones already in this week's grid, then your open ones.
  const options: Option[] = [];
  for (const r of week?.rows ?? []) options.push({ taskId: r.taskId, label: r.title, project: r.projectName });
  for (const m of mine) if (!options.some((o) => o.taskId === m.taskId)) options.push(m);
  const byProject = new Map<string, Option[]>();
  for (const o of options) byProject.set(o.project, [...(byProject.get(o.project) ?? []), o]);

  const minutes = parseDuration(length);
  const add = async () => {
    if (!taskId || minutes === null) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.post(`/tasks/${taskId}/time`, { day, minutes, ...(note.trim() ? { note: note.trim() } : {}) });
      setLength(""); setNote(""); setNotice(`Added ${formatMinutes(minutes)}.`);
      load();
    } catch (e) { setError(workError(e, "Couldn’t add the time")); }
    finally { setBusy(false); }
  };
  const openAdd = () => { setAdding(true); setNotice(""); setError(""); setTimeout(() => lengthBox.current?.focus(), 0); };
  const pick = (id: string, d: string) => { setTaskId(id); setDay(d); openAdd(); };

  const today = week ? todayIn(week.tz) : "";
  const sum = week ? weekSummary(week) : null;
  const thisWeek = week?.days.includes(today) ?? false;
  const capWeek = capacity?.weeks.find((w) => week?.days.includes(w.monday)) ?? null;
  const limit = capWeek?.limitMinutes ?? 0;
  const todayIndex = week ? week.days.indexOf(today) : -1;
  const clientOf = (projectId: string) => projects.find((p) => p.id === projectId)?.businessName ?? "";

  // Rows grouped by project (the server sorts them by project, then task).
  const groups: { projectId: string; name: string; rows: Week["rows"] }[] = [];
  for (const r of week?.rows ?? []) {
    const g = groups.find((x) => x.projectId === r.projectId);
    if (g) g.rows.push(r); else groups.push({ projectId: r.projectId, name: r.projectName, rows: [r] });
  }
  const estOf = (r: Week["rows"][number]) => info.get(r.projectId)?.est.get(r.taskId) ?? null;
  const hasEst = (week?.rows ?? []).some((r) => (estOf(r) ?? 0) > 0);
  const estTotal = (week?.rows ?? []).reduce((n, r) => n + (estOf(r) ?? 0), 0);

  const addPanel = adding && (
    <Card icon="plus" title="Add time" note="Or tap a day in the grid" action={<button type="button" className="ds-icon-btn" aria-label="Close" onClick={() => setAdding(false)}><Icon name="x" size={14} /></button>}>
      <form className="ds-form wkx-add-time" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="deal-field wide"><span>Task</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Choose a task</option>
            {[...byProject.entries()].map(([project, list]) => <optgroup key={project} label={project}>{list.map((o) => <option key={o.taskId} value={o.taskId}>{o.label}</option>)}</optgroup>)}
          </select></label>
        <label className="deal-field"><span>Day</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>{(week?.days ?? []).map((d) => { const l = dayLabel(d); return <option key={d} value={d}>{l.weekday} {l.date}{d === today ? " (today)" : ""}</option>; })}</select></label>
        <label className="deal-field wkx-short"><span>How long</span>
          <input ref={lengthBox} value={length} placeholder="1:30, 90m or 1.5h" onChange={(e) => setLength(e.target.value)} aria-invalid={length.trim() !== "" && minutes === null} />
          {length.trim() !== "" && minutes === null ? <small className="wkx-bad">Like 1:30, 90m or 1.5h</small> : <small>Hours and minutes</small>}</label>
        <label className="deal-field wide"><span>Note</span><input value={note} maxLength={500} placeholder="What you did (optional)" onChange={(e) => setNote(e.target.value)} /></label>
        {error && <p className="warn small wide" role="alert">{error}</p>}
        {notice && <p className="small wide" role="status">{notice}</p>}
        <div className="ds-form-actions">
          <button type="submit" className="btn primary" disabled={busy || !taskId || minutes === null || !day}>{minutes ? `Add ${formatMinutes(minutes)}` : "Add time"}</button>
          <button type="button" className="btn" onClick={() => setAdding(false)}>Close</button>
          <span className="ds-help wkx-push">{options.length === 0 ? "No open tasks to log against. Tasks come from your projects." : "Future days and locked tasks are refused. A timer logs here by itself."}</span>
        </div>
      </form>
    </Card>
  );

  const sub = week ? [`Week of ${weekLabel(week.days)}`, `${decimalHours(week.total)} hours ${thisWeek ? "so far" : "logged"}`, thisWeek ? "this week" : null].filter(Boolean).join(" · ") : failed ? "" : "Loading…";

  return (
    <div className="ds-page wkx">
      <PageHeader title="Timesheet" sub={sub}
        actions={<>
          <span className="wkx-week-nav">
            <button type="button" className="ds-icon-btn wkx-icon-32" aria-label="Previous week" title="Previous week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], -7))}><Icon name="chevron-left" size={16} /></button>
            <button type="button" className="ds-icon-btn wkx-icon-32" aria-label="Next week" title="Next week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], 7))}><Icon name="chevron-right" size={16} /></button>
          </span>
          {of !== null && <button type="button" className="btn" onClick={() => setOf(null)}>This week</button>}
          <button type="button" className="btn primary" aria-expanded={adding} onClick={() => (adding ? setAdding(false) : openAdd())}><Icon name="plus" size={16} />Add time</button>
        </>} />
      <div className="ds-body">
        {running && <TimerBanner entry={running} onStopped={load} />}
        {failed && <p className="error" role="alert">Couldn’t load the week. <button type="button" className="btn sm" onClick={load}>Try again</button></p>}
        {addPanel}
        {week && sum && (
          <>
            {week.total > 0 && <Stats label="This week in numbers">
              <Stat icon="clock" label={thisWeek ? "Hours this week" : "Hours that week"} value={decimalHours(sum.total)}
                sub={thisWeek && todayIndex >= 0 ? `${dayLabel(today).weekday}: ${decimalHours(week.dayTotals[todayIndex])} so far` : sum.daysWorked ? `Across ${sum.daysWorked} ${sum.daysWorked === 1 ? "day" : "days"}` : "Nothing logged"} />
              <Stat icon="calendar" label="Days worked" value={<>{sum.daysWorked}<small className="wkx-of"> of 7</small></>}
                sub={sum.daysWorked ? `${decimalHours(Math.round(sum.total / sum.daysWorked))} hours a day on average` : "Nothing logged yet"} />
              {limit > 0 ? (
                <Stat icon="gauge" label="Capacity" value={`${Math.round((sum.total / limit) * 100)}%`}
                  sub={`${decimalHours(sum.total)} of the ${Math.round(limit / 60)} hours you set${capWeek ? ` · ${decimalHours(capWeek.bookedMinutes)} booked` : ""}`} tone={sum.total >= limit ? "warning" : undefined} />
              ) : (
                <Stat icon="trending" label="Busiest day" value={sum.busiest ? `${dayLabel(sum.busiest.day).weekday} ${dayLabel(sum.busiest.day).date}` : "None yet"} sub={sum.busiest ? `${decimalHours(sum.busiest.minutes)} hours` : "No time logged"} />
              )}
            </Stats>}

            {week.rows.length === 0 ? (
              <div className={mine.length > 0 ? "ds-cols c2 wkx-project-cols" : ""}>
                <div className="ds-card">
                  <Empty icon="clock" title={thisWeek ? "No time logged this week" : "No time logged that week"} action={<button type="button" className="btn primary" onClick={openAdd}><Icon name="plus" size={16} />Add time</button>}>
                    Start a timer from any task’s More menu on a project, or add time by hand. Each task shows here as a row with a cell for each day.{limit > 0 && thisWeek ? ` You set ${Math.round(limit / 60)} hours for the week.` : ""}
                  </Empty>
                </div>
                {mine.length > 0 && (
                  <Card icon="list" title="Your open steps" note="Log time against one" flush>
                    {mine.slice(0, 6).map((m) => (
                      <div key={m.taskId} className="wkx-bill-row">
                        <span className="ds-tile info"><Icon name="user" size={16} /></span>
                        <span className="ds-link-text"><b>{m.label}</b><small>{m.project}</small></span>
                        <button type="button" className="btn sm" onClick={() => pick(m.taskId, thisWeek && today ? today : week.days[0])}>Log time</button>
                      </div>
                    ))}
                  </Card>
                )}
              </div>
            ) : (
              <div className="wkx-sheet-wrap">
                <table className="wkx-sheet">
                  <thead>
                    <tr>
                      <th scope="col" className="wkx-sheet-task">Task</th>
                      {hasEst && <th scope="col" className="wkx-est">Est.</th>}
                      {week.days.map((d) => { const l = dayLabel(d); return <th key={d} scope="col" className={`wkx-day${d === today ? " today" : ""}`}>{l.weekday} {l.date}</th>; })}
                      <th scope="col" className="wkx-total">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const st = info.get(g.projectId)?.status ?? null;
                      const client = clientOf(g.projectId);
                      return [
                        <tr key={`g-${g.projectId}`} className="wkx-sheet-group">
                          <th scope="rowgroup" colSpan={week.days.length + (hasEst ? 3 : 2)}>
                            <Link to={`/projects/${g.projectId}`}>{client ? `${client} · ` : ""}{g.name}</Link>
                            {st && <Chip tone={st.tone} dot>{st.label}</Chip>}
                          </th>
                        </tr>,
                        ...g.rows.map((r) => {
                          const est = estOf(r);
                          return (
                            <tr key={r.taskId}>
                              <th scope="row" className="wkx-sheet-task"><Link to={`/projects/${r.projectId}?task=${r.taskId}`}>{r.title}</Link></th>
                              {hasEst && <td className="wkx-est">{est ? decimalHours(est) : "–"}</td>}
                              {r.minutes.map((m, i) => {
                                const d = week.days[i];
                                const l = dayLabel(d);
                                return (
                                  <td key={d} className={`wkx-day${d === today ? " today" : ""}`}>
                                    <button type="button" className={`wkx-cell${m ? " has" : ""}`} aria-label={`${r.title}, ${l.weekday} ${l.date}: ${m ? formatMinutes(m) : "no time"}. Add time`} title={m ? formatMinutes(m) : "Add time"} onClick={() => pick(r.taskId, d)}>
                                      {m ? decimalHours(m) : <Icon name="plus" size={12} />}
                                    </button>
                                  </td>
                                );
                              })}
                              <td className="wkx-total">{decimalHours(r.total)}</td>
                            </tr>
                          );
                        }),
                      ];
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" className="wkx-sheet-task">Day total</th>
                      {hasEst && <td className="wkx-est">{decimalHours(estTotal)}</td>}
                      {week.dayTotals.map((m, i) => <td key={week.days[i]} className={`wkx-day${week.days[i] === today ? " today" : ""}`}>{m ? decimalHours(m) : ""}</td>)}
                      <td className="wkx-total big">{decimalHours(week.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {sum.byProject.length > 1 && (
              <Card icon="briefcase" title="By project" note="Share of the week" flush>
                {sum.byProject.map((p) => (
                  <Link key={p.projectId} to={`/projects/${p.projectId}`} className="wkx-share">
                    <span className="ds-link-text"><b>{p.name}</b><small>{clientOf(p.projectId)}</small></span>
                    <Meter value={p.minutes} max={sum.total} tone="signal" width={140} />
                    <span className="wkx-money">{decimalHours(p.minutes)} h</span>
                  </Link>
                ))}
              </Card>
            )}
            {week.rows.length > 0 && <Note>Hours are shown as decimals (1.5 is an hour and a half). Billable time feeds each project's hourly invoices and its Profit tab; Est. is each task's estimate for the whole task.</Note>}
          </>
        )}
      </div>
    </div>
  );
}
