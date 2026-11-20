import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { elapsedLabel } from "../timeView";
import { announceTimerChanged, TIMER_CHANGED, workError, type RunningEntry } from "../workData";
import Icon from "./Icon";

const POLL_MS = 60_000;
const TICK_MS = 15_000;

/** The running timer, in the rail: which task, for how long, and a Stop button. Nothing shows while no timer runs. Task and project names are shown as text. */
export default function TimerWidget() {
  const [entry, setEntry] = useState<RunningEntry | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.get<{ entry: RunningEntry | null }>("/time/running").then((r) => { setEntry(r.entry); setNow(new Date()); }).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    window.addEventListener(TIMER_CHANGED, load);
    return () => { clearInterval(poll); window.removeEventListener(TIMER_CHANGED, load); };
  }, [load]);
  useEffect(() => {
    if (!entry) return;
    const tick = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(tick);
  }, [entry]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const stop = async () => {
    setBusy(true); setError("");
    try { await api.post("/timer/stop"); setEntry(null); setOpen(false); announceTimerChanged(); }
    catch (e) { setError(workError(e, "Couldn’t stop the timer")); }
    finally { setBusy(false); }
  };

  if (!entry) return null;
  const elapsed = elapsedLabel(entry.startedAt, now);
  return (
    <div className="rail-pop wk-timer" ref={ref} style={{ position: "relative" }}>
      <button type="button" className="rail-btn wk-timer-btn" aria-label={`Timer running on ${entry.taskTitle}, ${elapsed}`} aria-expanded={open} title={`${entry.taskTitle}: ${elapsed}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="clock" size={18} /><span className="wk-timer-dot" aria-hidden="true" />
      </button>
      {open && (
        <div className="popover rail-left" role="dialog" aria-label="Running timer">
          <h4>Timer running</h4>
          <p className="wk-timer-task">{entry.taskTitle}</p>
          <p className="wk-timer-meta">{entry.projectName} · {elapsed}</p>
          {error && <p className="error wk-timer-meta" role="alert">{error}</p>}
          <div className="wk-timer-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void stop()}>Stop</button>
            <Link className="btn" to={`/projects/${encodeURIComponent(entry.projectId)}?task=${encodeURIComponent(entry.taskId)}`} onClick={() => setOpen(false)}>Open task</Link>
          </div>
        </div>
      )}
    </div>
  );
}
