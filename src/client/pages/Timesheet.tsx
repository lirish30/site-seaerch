import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { dayLabel, formatMinutes, parseDuration, shiftDay, weekLabel } from "../timeView";
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

  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>Timesheet</h1>
          <p>{week ? weekLabel(week.days) : "Loading…"}</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" aria-label="Previous week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], -7))}><Icon name="chevron-left" size={16} />Previous</button>
          <button type="button" className="btn" disabled={of === null} onClick={() => setOf(null)}>This week</button>
          <button type="button" className="btn" aria-label="Next week" disabled={!week} onClick={() => week && setOf(shiftDay(week.days[0], 7))}>Next<Icon name="chevron-right" size={16} /></button>
        </div>
      </header>
      <div className="wk-body">
        {failed && <p className="error" role="alert">Couldn’t load the week. <button type="button" className="btn" onClick={load}>Try again</button></p>}
        {!failed && !week && <p className="muted">Loading…</p>}
        {week && (
          <div className="wk-scroll">
            <table className="wk-grid">
              <thead>
                <tr>
                  <th scope="col" className="wk-task-col">Task</th>
                  {week.days.map((d) => { const l = dayLabel(d); return <th key={d} scope="col" className="num">{l.weekday}<br />{l.date}</th>; })}
                  <th scope="col" className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {week.rows.length === 0 && <tr><td colSpan={9} className="muted">No time logged this week.</td></tr>}
                {week.rows.map((r) => (
                  <tr key={r.taskId}>
                    <th scope="row" className="wk-task-col"><Link to={`/projects/${r.projectId}?task=${r.taskId}`}>{r.title}</Link><small>{r.projectName}</small></th>
                    {r.minutes.map((m, i) => (
                      <td key={week.days[i]} className="num">
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
                  {week.dayTotals.map((m, i) => <td key={week.days[i]} className="num">{m ? formatMinutes(m) : "·"}</td>)}
                  <td className="num"><b>{formatMinutes(week.total)}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <section className="card wk-add-time" aria-label="Add time">
          <h3>Add time</h3>
          <div className="wk-inline">
            <label className="deal-field"><span>Task</span>
              <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">Choose a task</option>
                {[...byProject.entries()].map(([project, list]) => <optgroup key={project} label={project}>{list.map((o) => <option key={o.taskId} value={o.taskId}>{o.label}</option>)}</optgroup>)}
              </select></label>
            <label className="deal-field"><span>Day</span>
              <select value={day} onChange={(e) => setDay(e.target.value)}>{(week?.days ?? []).map((d) => { const l = dayLabel(d); return <option key={d} value={d}>{l.weekday} {l.date}</option>; })}</select></label>
            <label className="deal-field"><span>How long (like 1:30, 90m or 1.5h)</span>
              <input ref={lengthBox} value={length} onChange={(e) => setLength(e.target.value)} aria-invalid={length.trim() !== "" && minutes === null} /></label>
            <label className="deal-field"><span>Note (optional)</span><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="btn primary" disabled={busy || !taskId || minutes === null || !day} onClick={() => void add()}>Add time</button>
          </div>
          {error && <p className="warn small" role="alert">{error}</p>}
          {notice && <p className="small" role="status">{notice}</p>}
          <p className="muted small">A day that has not come yet, or a task that is locked, is refused.</p>
        </section>
      </div>
    </div>
  );
}
