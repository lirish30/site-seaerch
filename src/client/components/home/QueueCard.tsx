import { Card, Chip } from "../ds";
import Icon from "../Icon";
import { openCount, QUEUE_HINT, queueLine, queueRows, type QueueStatus } from "../../queueView";
import type { Part } from "./useHome";

/** Work waiting for a Claude Code session (reviews, drafts, reply reads), per kind. It only reports: nothing here approves or sends. */
export default function QueueCard({ queue, onRetry }: { queue: Part<QueueStatus>; onRetry: () => void }) {
  const q = queue.data;
  const rows = q ? queueRows(q) : [];
  const n = q ? openCount(q.counts) : 0;
  return (
    <Card icon="sparkles" title="Claude queue" id="queue" className="hox-card" action={q && n > 0 ? <Chip tone="signal">{n} waiting</Chip> : undefined}>
      {!q && queue.error ? (
        <div className="hox-alert inline" role="alert"><span>{queue.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : !q ? (
        <i className="hox-skel" style={{ width: "50%", height: 18 }} />
      ) : rows.length === 0 ? (
        <p className="hox-ok"><Icon name="check" size={14} />{queueLine(q.counts)}</p>
      ) : (
        <>
          <ul className="hox-lines" aria-label="Open Claude tasks by kind">
            {rows.map((r) => (
              <li key={r.kind}>
                <span>{r.label}</span>
                <span className="hox-chips">
                  {r.claimed > 0 && <Chip tone="positive" dot>{r.claimed} working</Chip>}
                  {r.pending > 0 && <Chip tone="outline">{r.pending} queued</Chip>}
                </span>
              </li>
            ))}
          </ul>
          <p className="hox-caption">{QUEUE_HINT} Anything that goes out still waits for your OK.</p>
        </>
      )}
    </Card>
  );
}
