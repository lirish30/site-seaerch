import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { dayLabel, formatMinutes, parseDuration, shiftDay, todayIn, weekLabel, weekSummary } from "../timeView";
import { Card, EmptyState, Meter, StatRow, type Stat } from "../components/PageBits";
import type { Capacity } from "../../worker/capacity/compute";
import { TIMER_CHANGED, workError, type MyTasks, type Week } from "../workData";

interface Option { taskId: string; label: string; project: string }

/** The week as a grid: a row for each task with time in it, a column for each day, totals on the right and below. Add time by hand underneath (or tap a cell to start it there). */
export default function Timesheet() {
  // null is "this week": the server picks today in your time zone.
  const [of, setOf] = useState<string | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [mine, setMine] = useState<Option[]>([]);
  const [failed, setFailed] = useState(false);
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

  const load = useCallback(() => {
    setFailed(false);
    api.get<Week>(`/time/week${of ? `?of=${of}` : ""}`).then((w) => { setWeek(w); setDay((d) => (w.days.includes(d) ? d : w.days[0])); }).catch(() => setFailed(true));
  }, [of]);
  useEffect(() => {
    load();
    window.addEventListener(TIMER_CHANGED, load);
    return () => window.removeEventListener(TIMER_CHANGED, load);
  }, [load]);
  useEffect(() => {
    api.get<MyTasks>("/me/tasks").then((r) => setMine(r.projects.flatMap((p) => p.tasks.map((t) => ({ taskId: t.id, label: t.title, project: p.projectName }))))).catch(() => setMine([]));
  }, []);

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
  const pick = (id: string, d: string) => { setTaskId(id); setDay(d); lengthBox.current?.focus(); };

  const today = week ? todayIn(week.tz) : "";
  const sum = week ? weekSummary(week) : null;
  const thisWeek = week?.days.includes(today) ?? false;
  const capWeek = capacity?.weeks.find((w) => week?.days.includes(w.monday)) ?? null;
  const limit = capWeek?.limitMinutes ?? 0;
  const stats: Stat[] = sum && week ? [
    { label: "Logged", icon: "clock", value: formatMinutes(sum.total),
      sub: limit ? <><Meter value={sum.total} max={limit} label={`${formatMinutes(sum.total)} of ${formatMinutes(limit)}`} /><span className="pb-hint">of your {Math.round(limit / 60)} h week{capWeek ? ` · ${formatMinutes(capWeek.bookedMinutes)} booked` : ""}</span></> : thisWeek ? "So far this week" : "That week" },
    { label: "Days worked", icon: "calendar", value: <>{sum.daysWorked}<small>of 7</small></>, sub: sum.daysWorked ? `${formatMinutes(Math.round(sum.total / sum.daysWorked))} a day on average` : "Nothing logged yet" },
    { label: "Busiest day", icon: "zap", value: sum.busiest ? `${dayLabel(sum.busiest.day).weekday} ${dayLabel(sum.busiest.day).date}` : "—", sub: sum.busiest ? formatMinutes(sum.busiest.minutes) : "No time logged" },
    { label: "Most time on", icon: "briefcase", value: sum.byProject[0] ? `${Math.round((sum.byProject[0].minutes / Math.max(1, sum.total)) * 100)}%` : "—", sub: sum.byProject[0]?.name ?? "No project yet" },
  ] : [];
  const peak = Math.max(1, ...(week?.dayTotals ?? [0]));

  const addForm = (
    <Card icon="plus" title="Add time" className="ts-add" note={taskId ? undefined : "Or tap a cell in the grid"}>
      <div className="wk-inline">
        <label className="deal-field wide"><span>Task</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Choose a task</option>
            {[...byProject.entries()].map(([project, list]) => <optgroup key={project} label={project}>{list.map((o) => <option key={o.taskId} value={o.taskId}>{o.label}</option>)}</optgroup>)}
          </select></label>
        <label className="deal-field"><span>Day</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>{(week?.days ?? []).map((d) => { const l = dayLabel(d); return <option key={d} value={d}>{l.weekday} {l.date}{d === today ? " (today)" : ""}</option>; })}</select></label>
        <label className="deal-field"><span>How long</span>
          <input ref={lengthBox} value={length} placeholder="1:30, 90m or 1.5h" onChange={(e) => setLength(e.target.value)} aria-invalid={length.trim() !== "" && minutes === null} /></label>
        <label className="deal-field wide"><span>Note (optional)</span><input value={note} maxLength={500} placeholder="What you did" onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" className="btn primary" disabled={busy || !taskId || minutes === null || !day} onClick={() => void add()}>{minutes ? `Add ${formatMinutes(minutes)}` : "Add time"}</button>
      </div>
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice}</p>}
      <p className="pb-hint">{options.length === 0 ? "No open tasks to log against. Tasks come from your projects." : "Future days and locked tasks are refused. The timer on any task logs here by itself."}</p>
    </Card>
  );

  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>Timesheet</h1>
          <p>{week ? `${weekLabel(week.days)}${thisWeek ? " · this week" : ""}. Where your hours went, by task and day.` : "Loading…"}</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" aria-label="Previous week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], -7))}><Icon name="chevron-left" size={16} />Previous</button>
          <button type="button" className="btn" disabled={of === null} onClick={() => setOf(null)}>This week</button>
          <button type="button" className="btn" aria-label="Next week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], 7))}>Next<Icon name="chevron-right" size={16} /></button>
        </div>
      </header>
      <div className="pb-page">
        {failed && <p className="error" role="alert">Couldn’t load the week. <button type="button" className="btn" onClick={load}>Try again</button></p>}
        {!failed && !week && <p className="muted">Loading…</p>}
        {week && sum && (
          <>
            <StatRow stats={stats} label="This week in numbers" />
            <div className="pb-cols">
              <div className="pb-side">
                {week.rows.length === 0 ? (
                  <EmptyState icon="clock" title={thisWeek ? "No time logged this week" : "No time logged that week"}
                    steps={[
                      { title: "Start a timer", text: "Every task on a project has Start timer. Stop it and the time lands here.", to: "/projects" },
                      { title: "Or add it by hand", text: "Pick the task and day in Add time, then type 1:30, 90m or 1.5h." },
                      { title: "See the profit", text: "Logged time feeds each project's Profit tab, so you know what a job really paid per hour." },
                    ]}>
                    Hours you log show up as a grid of tasks by day.
                  </EmptyState>
                ) : (
                  <Card icon="grid" title="Tasks by day" note={`${week.rows.length} task${week.rows.length === 1 ? "" : "s"} · ${sum.byProject.length} project${sum.byProject.length === 1 ? "" : "s"}`} flush className="ts-grid-card">
                    <div className="wk-scroll">
                      <table className="wk-grid">
                        <thead>
                          <tr>
                            <th scope="col" className="wk-task-col">Task</th>
                            {week.days.map((d) => { const l = dayLabel(d); return <th key={d} scope="col" className={`num${d === today ? " today" : ""}`}>{l.weekday}<br />{l.date}</th>; })}
                            <th scope="col" className="num">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {week.rows.map((r) => (
                            <tr key={r.taskId}>
                              <th scope="row" className="wk-task-col"><Link to={`/projects/${r.projectId}?task=${r.taskId}`}>{r.title}</Link><small>{r.projectName}</small></th>
                              {r.minutes.map((m, i) => (
                                <td key={week.days[i]} className={`num${week.days[i] === today ? " today" : ""}`}>
                                  <button type="button" className={`wk-cell${m ? " has" : ""}`} aria-label={`${r.title}, ${dayLabel(week.days[i]).weekday} ${dayLabel(week.days[i]).date}: ${m ? formatMinutes(m) : "no time"}. Add time`} onClick={() => pick(r.taskId, week.days[i])}>{m ? formatMinutes(m) : "·"}</button>
                                </td>
                              ))}
                              <td className="num"><b>{formatMinutes(r.total)}</b></td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <th scope="row" className="wk-task-col">Day total</th>
                            {week.dayTotals.map((m, i) => <td key={week.days[i]} className={`num${week.days[i] === today ? " today" : ""}`}>{m ? formatMinutes(m) : "·"}</td>)}
                            <td className="num"><b>{formatMinutes(week.total)}</b></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </Card>
                )}
                {sum.byProject.length > 0 && (
                  <Card icon="briefcase" title="By project" note="Share of the week">
                    <ul className="pb-rows">
                      {sum.byProject.map((p) => (
                        <li key={p.projectId}>
                          <Link to={`/projects/${p.projectId}`}>{p.name}</Link>
                          <Meter value={p.minutes} max={sum.total} />
                          <b>{formatMinutes(p.minutes)}</b>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
              <div className="pb-side">
                <Card icon="calendar" title="The week" note={formatMinutes(week.total)}>
                  <div className="ts-days" role="img" aria-label={week.days.map((d, i) => `${dayLabel(d).weekday} ${formatMinutes(week.dayTotals[i])}`).join(", ")}>
                    {week.days.map((d, i) => (
                      <span key={d} className={`ts-day${d === today ? " today" : ""}${week.dayTotals[i] ? "" : " zero"}`}>
                        <i style={{ height: `${Math.max(4, Math.round((week.dayTotals[i] / peak) * 64))}px` }} />
                        {dayLabel(d).weekday.slice(0, 2)}
                      </span>
                    ))}
                  </div>
                </Card>
                {addForm}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
