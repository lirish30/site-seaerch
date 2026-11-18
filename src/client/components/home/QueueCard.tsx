import Icon from "../Icon";
import { QUEUE_HINT, queueLine, queueRows, type QueueStatus } from "../../queueView";
import type { Part } from "./useHome";

/** Work waiting for a Claude Code session (reviews, drafts, reply reads), per kind. It only reports: nothing here approves or sends. */
export default function QueueCard({ queue, onRetry }: { queue: Part<QueueStatus>; onRetry: () => void }) {
  const q = queue.data;
  const rows = q ? queueRows(q) : [];
  return (
    <section className="hm-card hm-queue" id="queue" aria-labelledby="hm-queue-h">
      <header className="hm-card-head">
        <Icon name="sparkles" size={16} />
        <h2 id="hm-queue-h">Claude queue</h2>
        {q && <span className="hm-head-note small">{queueLine(q.counts)}</span>}
      </header>
      {!q && queue.error ? (
        <div className="hm-state sm" role="alert"><p>{queue.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !q ? (
        <div className="hm-card-body"><i className="hm-skel" style={{ width: "50%", height: 18 }} /></div>
      ) : rows.length === 0 ? (
        <div className="hm-state sm" role="status"><p>{queueLine(q.counts)}</p></div>
      ) : (
        <div className="hm-queue-body">
          <ul className="hm-queue-list" aria-label="Open Claude tasks by kind">
            {rows.map((r) => (
              <li key={r.kind}>
                <span>{r.label}</span>
                <span className="hm-queue-n">{r.pending + r.claimed}{r.claimed > 0 && <small>{r.claimed} in progress</small>}</span>
              </li>
            ))}
          </ul>
          <p className="hm-queue-hint">{QUEUE_HINT}</p>
        </div>
      )}
    </section>
  );
}
