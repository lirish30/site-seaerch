/** The queue of work waiting for a Claude session, as GET /api/queue returns it. Only counts and labels: never a task's content. */
export type QueueCounts = Record<string, { pending: number; claimed: number }>;
export interface QueueStatus { counts: QueueCounts; labels: Record<string, string>; oldestPendingAt: string | null }
export interface QueueRow { kind: string; label: string; pending: number; claimed: number }

export const QUEUE_HINT = "Run /work-the-queue in Claude Code to clear them.";

const rowTotal = (c: { pending: number; claimed: number }) => c.pending + c.claimed;

/** Tasks open in all: waiting for a session (pending) or being worked (claimed). */
export const openCount = (counts: QueueCounts): number => Object.values(counts).reduce((n, c) => n + rowTotal(c), 0);

export function queueLine(counts: QueueCounts): string {
  const n = openCount(counts);
  return n === 0 ? "Claude has nothing waiting." : `${n} task${n === 1 ? "" : "s"} waiting for a Claude session.`;
}

/** One row per kind with open work, the biggest first. A kind the response has no label for shows its id. */
export function queueRows(q: QueueStatus): QueueRow[] {
  return Object.entries(q.counts)
    .filter(([, c]) => rowTotal(c) > 0)
    .map(([kind, c]) => ({ kind, label: q.labels[kind] ?? kind, pending: c.pending, claimed: c.claimed }))
    .sort((a, b) => rowTotal(b) - rowTotal(a) || a.label.localeCompare(b.label));
}

/** Shown beside a lead's audit while Claude's review of the site is still in the queue. */
export const reviewPendingNote = (pending: boolean | undefined): string | null => (pending ? "AI review pending" : null);
