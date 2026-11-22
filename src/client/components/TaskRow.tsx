import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { ownerChip, shortDate, taskFlag, taskState } from "../projectView";
import { Link } from "react-router-dom";
import { clockText, formatMinutes, varianceLabel } from "../timeView";
import { announceTimerChanged, workError, type RunningEntry, type TaskDetail } from "../workData";
import { Banner, Chip } from "./ds";
import Icon from "./Icon";
import type { Task } from "../../worker/db/tasks";
import type { ProjectStatus } from "../../worker/db/projects";

const AUTHOR = { logan: "You", claude: "Claude", system: "Activity" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "25m of 45m, 20% over", "25m logged", or nothing. */
function timeLine(est: number, actual: number): string {
  if (est > 0) return `${formatMinutes(actual)} of ${formatMinutes(est)}${actual > 0 ? `, ${varianceLabel(est, actual)}` : ""}`;
  return actual > 0 ? `${formatMinutes(actual)} logged, no estimate` : "";
}

/**
 * A small "More" dropdown (ui.css `.menu`): an icon or labelled summary, a list of buttons. It closes on a pick, a click outside or Escape.
 * Each item is a plain button so the actions stay reachable by keyboard and screen reader.
 */
export function RowMenu({ label, children, summary, className = "" }: { label: string; children: (close: () => void) => ReactNode; summary?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (ref.current) ref.current.open = false; setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <details ref={ref} className={`menu wkx-menu ${className}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={summary ? "btn" : "ds-icon-btn"} aria-label={label} title={label}>{summary ?? <Icon name="more" size={16} />}</summary>
      {open && <div className="menu-list" role="menu">{children(close)}</div>}
    </details>
  );
}

/**
 * The Signal banner for a running timer: which task, a ticking clock, Stop and Open task. Used on the Timesheet and on the project the timer is in.
 * It stops the timer with the same call as the rail widget and announces the change so the widget and the page re-read.
 */
export function TimerBanner({ entry, onStopped }: { entry: RunningEntry; onStopped?: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const stop = async () => {
    setBusy(true); setError("");
    try { await api.post("/timer/stop"); announceTimerChanged(); onStopped?.(); }
    catch (e) { setError(workError(e, "Couldn’t stop the timer")); }
    finally { setBusy(false); }
  };
  return (
    <Banner tone="signal" icon="clock" title="Timer running"
      action={<span className="wkx-timer-actions">
        <span className="wkx-clock" aria-label="Time on the clock">{clockText(entry.startedAt, now)}</span>
        <Link className="btn sm" to={`/projects/${encodeURIComponent(entry.projectId)}?task=${encodeURIComponent(entry.taskId)}`}>Open task</Link>
        <button type="button" className="btn sm primary" disabled={busy} onClick={() => void stop()}><Icon name="x" size={14} />Stop</button>
      </span>}>
      {entry.projectName} · {entry.taskTitle}{error && <span className="wkx-err"> {error}</span>}
    </Banner>
  );
}

interface Props {
  task: Task;
  all: Task[];
  actualMinutes: number;
  /** The task the running timer is on, if any. */
  runningTaskId: string | null;
  projectStatus: ProjectStatus;
  /** Open on first render (a link from an approval opens the step it is about). */
  startOpen?: boolean;
  onChange: () => Promise<void>;
}

/**
 * One task as a row: the checkbox marks it done (or reopens it), the title opens what it is done when, the client's summary, the checklist, the notes and "Ask Claude".
 * Who does it, the estimate and the due date sit on the right; Start, Skip, Waiting on client and the timer are in the row's More menu. Everything written by the client,
 * Claude or Logan is shown as text. A refused Start or Done names the steps in the way.
 */
export default function TaskRow({ task, all, actualMinutes, runningTaskId, projectStatus, startOpen = false, onChange }: Props) {
  const [open, setOpen] = useState(startOpen);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const row = useRef<HTMLLIElement>(null);

  const state = taskState(task, all);
  const flag = taskFlag(task, all);
  const owner = ownerChip(task);
  const live = projectStatus !== "cancelled";
  const blocked = state.blockedBy.length > 0;
  const closed = task.status === "done" || task.status === "skipped";
  const timing = runningTaskId === task.id;
  const canWork = live && !closed && task.status !== "locked";

  // A link to a task can arrive after the row is already on screen (the page polls), so opening follows the prop rather than only its first value.
  useEffect(() => { if (startOpen) { setOpen(true); row.current?.scrollIntoView({ block: "center" }); } }, [startOpen]);
  const loadDetail = () => api.get<TaskDetail>(`/tasks/${task.id}`).then(setDetail).catch((e) => setError(workError(e, "Couldn’t load the task")));
  useEffect(() => { if (open) void loadDetail(); }, [open, task.updatedAt]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await onChange(); if (open) await loadDetail(); if (done) setNotice(done); }
    catch (e) { setError(workError(e)); await onChange().catch(() => {}); }
    finally { setBusy(false); }
  };

  const complete = () => run(() => api.post(`/tasks/${task.id}/complete`));
  const reopen = () => run(() => api.post(`/tasks/${task.id}/reopen`));
  const start = () => run(() => api.post(`/tasks/${task.id}/start`));
  const waiting = (on: boolean) => run(() => api.post(`/tasks/${task.id}/waiting`, { on }));
  const toggleItem = (i: number) => run(() => api.patch(`/tasks/${task.id}`, { checklist: task.checklist.map((c, j) => (j === i ? { ...c, done: !c.done } : c)) }));
  const skip = () => run(async () => { await api.post(`/tasks/${task.id}/skip`, { reason }); setSkipping(false); setReason(""); });
  const toggleTimer = () => run(async () => {
    if (timing) await api.post("/timer/stop"); else await api.post(`/tasks/${task.id}/timer/start`);
    announceTimerChanged();
  });
  const post = () => run(async () => { await api.post(`/tasks/${task.id}/comment`, { body: comment }); setComment(""); });
  const askClaude = () => run(async () => { await api.post(`/tasks/${task.id}/ask-claude`, { note: note.trim() || undefined }); setNote(""); }, "Asked Claude. It starts when a slot is free.");
  const sendBack = () => run(async () => { await api.post(`/tasks/${task.id}/send-back`, { note: note.trim() || undefined }); setNote(""); }, "Sent back to Claude.");

  const time = timeLine(task.estMinutes, actualMinutes);
  const shownTime = task.estMinutes > 0 ? formatMinutes(task.estMinutes) : actualMinutes > 0 ? formatMinutes(actualMinutes) : "–";
  const due = closed ? (task.doneAt ? shortDate(task.doneAt) : "") : task.dueOn ? `Due ${shortDate(task.dueOn)}` : "";
  const canCheck = live && (closed || (canWork && !blocked));
  const canStart = canWork && (task.status === "todo" || task.status === "waiting_client" || task.status === "in_review");
  const sub = blocked ? `Waiting on: ${state.blockedBy.join(", ")}` : task.doneWhen ? `Done when: ${task.doneWhen}` : task.status === "skipped" ? "Skipped" : "";

  return (
    <li ref={row} className={`wkx-task${closed ? " closed" : ""}${open ? " open" : ""}${timing ? " timing" : ""}`} id={`task-${task.id}`}>
      <div className="wkx-task-row">
        <input type="checkbox" className="cb" checked={closed} disabled={busy || !canCheck}
          title={closed ? "Reopen this task" : blocked ? "Finish the steps it waits on first" : "Mark done"}
          aria-label={closed ? `Reopen: ${task.title}` : `Mark done: ${task.title}`}
          onChange={() => void (closed ? reopen() : complete())} />
        <button type="button" className="wkx-task-text" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <b>{task.title}</b>
          {sub && <small className={blocked ? "blocked" : ""}>{sub}</small>}
        </button>
        <span className="wkx-task-chips">
          {timing && <Chip tone="signal" dot>Timer running</Chip>}
          {flag && <Chip tone={flag.tone}>{flag.label}</Chip>}
          {task.status !== "skipped" && <Chip tone={owner.tone}>{owner.label}</Chip>}
        </span>
        <span className="wkx-task-time" title={time || undefined}>{shownTime}</span>
        <span className={`wkx-task-due${closed ? "" : " open"}`}>{due}</span>
        {live && (
          <RowMenu label={`More for ${task.title}`}>
            {(close) => {
              const pick = (fn: () => unknown) => () => { close(); void fn(); };
              return (
                <>
                  {canWork && <button type="button" role="menuitem" disabled={busy || blocked} onClick={pick(complete)}>Mark done</button>}
                  {canStart && <button type="button" role="menuitem" disabled={busy || blocked} onClick={pick(start)}>Start it</button>}
                  {canWork && <button type="button" role="menuitem" disabled={busy} onClick={pick(toggleTimer)}>{timing ? "Stop the timer" : "Start a timer"}</button>}
                  {canWork && (task.status === "waiting_client"
                    ? <button type="button" role="menuitem" disabled={busy} onClick={pick(() => waiting(false))}>Back to work (client replied)</button>
                    : <button type="button" role="menuitem" disabled={busy} onClick={pick(() => waiting(true))}>Mark waiting on client</button>)}
                  {canWork && <button type="button" role="menuitem" disabled={busy} onClick={pick(() => setSkipping(true))}>Skip this step…</button>}
                  {closed && <button type="button" role="menuitem" disabled={busy} onClick={pick(reopen)}>Reopen</button>}
                  <hr />
                  <button type="button" role="menuitem" onClick={pick(() => setOpen(true))}>Notes, checklist and Claude</button>
                </>
              );
            }}
          </RowMenu>
        )}
      </div>

      {(skipping || error || notice) && (
        <div className="wkx-task-msgs">
          {skipping && (
            <div className="wk-inline">
              <label className="deal-field"><span>Why skip it? (3 to 300 characters; it goes in the notes)</span><input value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} /></label>
              <button type="button" className="btn primary" disabled={busy || reason.trim().length < 3} onClick={() => void skip()}>Skip this step</button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setSkipping(false); setReason(""); }}>Cancel</button>
            </div>
          )}
          {error && <p className="warn small" role="alert">{error}</p>}
          {notice && <p className="small" role="status">{notice}</p>}
        </div>
      )}

      {open && (
        <div className="wkx-task-more">
          <div className="wkx-task-facts">
            {task.description && <p className="wk-text">{task.description}</p>}
            {task.clientSummary && <p><span className="wkx-label">The client sees</span> <span className="wk-text">{task.clientSummary}</span></p>}
            <p><span className="wkx-label">Status</span> {state.label}{time ? ` · ${time}` : ""}{detail && detail.time.entries.length > 0 ? ` · ${detail.time.entries.length} time ${detail.time.entries.length === 1 ? "entry" : "entries"}` : ""}</p>
          </div>
          {task.checklist.length > 0 && (
            <ul className="wkx-checks" aria-label="Checklist">
              {task.checklist.map((c, i) => (
                <li key={i}><label><input type="checkbox" className="cb" checked={c.done} disabled={busy || !live} onChange={() => void toggleItem(i)} /><span className={c.done ? "wkx-done" : ""}>{c.text}</span></label></li>
              ))}
            </ul>
          )}

          <section aria-label="Notes" className="wkx-notes">
            <h4 className="wkx-label">Notes</h4>
            {!detail && <p className="muted small">Loading…</p>}
            {detail && detail.comments.length === 0 && <p className="muted small">No notes yet. Anything you or Claude write about this step shows here.</p>}
            {detail && detail.comments.length > 0 && (
              <ul className="wkx-comments">
                {detail.comments.map((c) => <li key={c.id} className={c.author}><b>{AUTHOR[c.author]}</b> <small>{when(c.createdAt)}</small><p className="wk-text">{c.body}</p></li>)}
              </ul>
            )}
            {live && (
              <div className="wk-inline">
                <label className="deal-field"><span>Add a note (no passwords or logins)</span><textarea rows={2} value={comment} maxLength={4000} onChange={(e) => setComment(e.target.value)} /></label>
                <button type="button" className="btn" disabled={busy || !comment.trim()} onClick={() => void post()}>Add note</button>
              </div>
            )}
          </section>

          {live && !closed && task.status !== "locked" && (
            <section aria-label="Claude" className="wk-inline">
              <label className="deal-field"><span>A note for Claude (optional)</span><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
              <button type="button" className="btn" disabled={busy} onClick={() => void askClaude()}><Icon name="sparkles" size={16} />Ask Claude</button>
              {task.status === "in_review" && <button type="button" className="btn" disabled={busy} onClick={() => void sendBack()}>Send back</button>}
            </section>
          )}
        </div>
      )}
    </li>
  );
}
