import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ownerBadge, taskState, type Tone } from "../projectView";
import { formatMinutes, varianceLabel } from "../timeView";
import { announceTimerChanged, workError, type TaskDetail } from "../workData";
import type { Task } from "../../worker/db/tasks";
import type { ProjectStatus } from "../../worker/db/projects";

const TONE: Record<Tone, string> = { neutral: "outline", good: "positive", warn: "warning", muted: "" };
const AUTHOR = { logan: "You", claude: "Claude", system: "Activity" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "25m of 45m, 20% over", "25m logged", or nothing. */
function timeLine(est: number, actual: number): string {
  if (est > 0) return `${formatMinutes(actual)} of ${formatMinutes(est)}${actual > 0 ? `, ${varianceLabel(est, actual)}` : ""}`;
  return actual > 0 ? `${formatMinutes(actual)} logged, no estimate` : "";
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
 * One task: its state, owner, estimate against time spent, and the buttons that move it on. Open it for what it is done when, the client's summary, the checklist,
 * the notes and "Ask Claude". Everything written by the client, Claude or Logan is shown as text. A refused Start or Done names the steps in the way.
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
  const live = projectStatus !== "cancelled";
  const blocked = state.blockedBy.length > 0;
  const closed = task.status === "done" || task.status === "skipped";
  const timing = runningTaskId === task.id;
  const canWork = live && !closed && task.status !== "locked";

  useEffect(() => { if (startOpen) row.current?.scrollIntoView({ block: "center" }); }, [startOpen]);
  const loadDetail = () => api.get<TaskDetail>(`/tasks/${task.id}`).then(setDetail).catch((e) => setError(workError(e, "Couldn’t load the task")));
  useEffect(() => { if (open) void loadDetail(); }, [open, task.updatedAt]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await onChange(); if (open) await loadDetail(); if (done) setNotice(done); }
    catch (e) { setError(workError(e)); await onChange().catch(() => {}); }
    finally { setBusy(false); }
  };

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
  return (
    <li ref={row} className={`wk-task${closed ? " closed" : ""}${open ? " open" : ""}`} id={`task-${task.id}`}>
      <div className="wk-task-main">
        <button type="button" className="wk-task-title" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="wk-task-name">{task.title}</span>
          <span className="wk-task-meta">
            <span className="badge2">{ownerBadge(task.owner)}</span>
            <span className={`badge2 ${TONE[state.tone]}`}><i className="dot" />{state.label}</span>
            {timing && <span className="badge2 signal"><i className="dot" />Timing</span>}
            {time && <span className="wk-time">{time}</span>}
          </span>
        </button>
        {blocked && <p className="wk-blocked small">Waiting on: {state.blockedBy.join(", ")}</p>}
        {canWork && (
          <div className="wk-task-actions">
            {(task.status === "todo" || task.status === "waiting_client" || task.status === "in_review") && <button type="button" className="btn" disabled={busy || blocked} onClick={() => void run(() => api.post(`/tasks/${task.id}/start`))}>Start</button>}
            <button type="button" className="btn primary" disabled={busy || blocked} onClick={() => void run(() => api.post(`/tasks/${task.id}/complete`))}>Done</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setSkipping((s) => !s)} aria-expanded={skipping}>Skip</button>
            {task.status === "waiting_client"
              ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/tasks/${task.id}/waiting`, { on: false }))}>Back to work</button>
              : <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/tasks/${task.id}/waiting`, { on: true }))}>Waiting on client</button>}
            <button type="button" className={`btn${timing ? " primary" : ""}`} disabled={busy} aria-pressed={timing} onClick={() => void toggleTimer()}>{timing ? "Stop timer" : "Start timer"}</button>
          </div>
        )}
        {live && closed && <div className="wk-task-actions"><button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/tasks/${task.id}/reopen`))}>Reopen</button></div>}
        {skipping && (
          <div className="wk-inline">
            <label className="deal-field"><span>Why skip it? (3 to 300 characters; it goes in the notes)</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
            <button type="button" className="btn primary" disabled={busy || reason.trim().length < 3} onClick={() => void skip()}>Skip this step</button>
          </div>
        )}
        {error && <p className="warn small wk-msg" role="alert">{error}</p>}
        {notice && <p className="small wk-msg" role="status">{notice}</p>}
      </div>

      {open && (
        <div className="wk-task-more">
          {task.description && <p className="wk-text">{task.description}</p>}
          {task.doneWhen && <p className="small"><b>Done when:</b> <span className="wk-text">{task.doneWhen}</span></p>}
          {task.clientSummary && <p className="small"><b>The client sees:</b> <span className="wk-text">{task.clientSummary}</span></p>}
          {task.dueOn && <p className="small"><b>Due:</b> {task.dueOn}</p>}
          {task.checklist.length > 0 && (
            <ul className="wk-checks" aria-label="Checklist">
              {task.checklist.map((c, i) => (
                <li key={i}><label><input type="checkbox" className="cb" checked={c.done} disabled={busy || !live} onChange={() => void toggleItem(i)} /><span className={c.done ? "wk-done" : ""}>{c.text}</span></label></li>
              ))}
            </ul>
          )}
          {detail && detail.time.entries.length > 0 && <p className="muted small">{detail.time.entries.length} time {detail.time.entries.length === 1 ? "entry" : "entries"}, {formatMinutes(detail.time.actualMinutes)} in all.</p>}

          <section aria-label="Notes">
            <h4 className="wk-sub">Notes</h4>
            {!detail && <p className="muted small">Loading…</p>}
            {detail && detail.comments.length === 0 && <p className="muted small">No notes yet.</p>}
            {detail && detail.comments.length > 0 && (
              <ul className="wk-comments">
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
            <section aria-label="Claude">
              <div className="wk-inline">
                <label className="deal-field"><span>A note for Claude (optional)</span><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
                <button type="button" className="btn" disabled={busy} onClick={() => void askClaude()}>Ask Claude</button>
                {task.status === "in_review" && <button type="button" className="btn" disabled={busy} onClick={() => void sendBack()}>Send back</button>}
              </div>
            </section>
          )}
        </div>
      )}
    </li>
  );
}
