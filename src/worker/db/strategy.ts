// Strategy memo data (Plan 16): a client's memo, numbered per client, in the same shape and with the same rules as the Care report (Plan 13).
// Times are UTC ISO strings with milliseconds. A memo's `facts` are a JSON snapshot taken when it is made; every state change is one compare-and-set statement.

export type StrategyStatus = "collecting" | "ready" | "sent" | "revoked" | "cancelled";

export interface StrategyMemo {
  id: string; businessId: string; version: number; status: StrategyStatus; token: string;
  /** The snapshot of facts (typed by the memo builder; read back as parsed JSON, or null when unreadable). */
  facts: unknown;
  /** Claude's words around the facts (`{}` until the memo is ready). */
  body: unknown;
  claudeTaskId: string | null; approvalId: string | null; test: boolean;
  createdAt: string; readyAt: string | null; sentAt: string | null; firstViewedAt: string | null; viewCount: number; revokedAt: string | null;
}

interface Row {
  id: string; business_id: string; version: number; status: StrategyStatus; token: string; facts: string; body: string; claude_task_id: string | null; approval_id: string | null; test: number;
  created_at: string; ready_at: string | null; sent_at: string | null; first_viewed_at: string | null; view_count: number; revoked_at: string | null;
}

const parse = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return null; }
};

const toMemo = (r: Row): StrategyMemo => ({
  id: r.id, businessId: r.business_id, version: r.version, status: r.status, token: r.token, facts: parse(r.facts), body: parse(r.body), claudeTaskId: r.claude_task_id, approvalId: r.approval_id,
  test: !!r.test, createdAt: r.created_at, readyAt: r.ready_at, sentAt: r.sent_at, firstViewedAt: r.first_viewed_at, viewCount: r.view_count, revokedAt: r.revoked_at,
});

const changed = (res: { meta: { changes?: number } }) => (res.meta.changes ?? 0) === 1;

export async function getMemo(db: D1Database, id: string): Promise<StrategyMemo | null> {
  const r = await db.prepare(`SELECT * FROM strategy_memos WHERE id = ?`).bind(id).first<Row>();
  return r ? toMemo(r) : null;
}

export async function getMemoByToken(db: D1Database, token: string): Promise<StrategyMemo | null> {
  const r = await db.prepare(`SELECT * FROM strategy_memos WHERE token = ?`).bind(token).first<Row>();
  return r ? toMemo(r) : null;
}

/** A client's memos, newest first. */
export async function listMemos(db: D1Database, businessId: string): Promise<StrategyMemo[]> {
  const rows = (await db.prepare(`SELECT * FROM strategy_memos WHERE business_id = ? ORDER BY version DESC`).bind(businessId).all<Row>()).results;
  return rows.map(toMemo);
}

/**
 * Makes a client's next memo (the next version number), once at a time: while the client has an open memo (`collecting` or `ready`) a second call (or a racing one) changes nothing
 * and returns that memo with `created: false`.
 */
export async function insertMemo(
  db: D1Database, p: { businessId: string; token: string; facts: unknown; test: boolean; now: string },
): Promise<{ memo: StrategyMemo; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO strategy_memos (id, business_id, version, status, token, facts, test, created_at)
     SELECT ?, ?, COALESCE(MAX(version), 0) + 1, 'collecting', ?, ?, ?, ? FROM strategy_memos WHERE business_id = ?
     ON CONFLICT DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), p.businessId, p.token, JSON.stringify(p.facts), p.test ? 1 : 0, p.now, p.businessId).first<Row>();
  if (made) return { memo: toMemo(made), created: true };
  const open = await db.prepare(`SELECT * FROM strategy_memos WHERE business_id = ? AND status IN ('collecting', 'ready')`).bind(p.businessId).first<Row>();
  if (!open) throw new Error("could not make the strategy memo");
  return { memo: toMemo(open), created: false };
}

/** Sets the memo's words and makes it `ready` (stamping `ready_at`); only a `collecting` memo takes them, so two callers cannot both win. False when it was not collecting. */
export async function setMemoBody(db: D1Database, id: string, body: unknown, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE strategy_memos SET body = ?, status = 'ready', ready_at = ? WHERE id = ? AND status = 'collecting'`).bind(JSON.stringify(body ?? null), now, id).run());
}

/** Links the Claude job and the approval that go with the memo; a field left out is not touched. */
export async function setMemoLinks(db: D1Database, id: string, p: { claudeTaskId?: string | null; approvalId?: string | null }): Promise<void> {
  await db.prepare(
    `UPDATE strategy_memos SET claude_task_id = CASE WHEN ? = 1 THEN ? ELSE claude_task_id END, approval_id = CASE WHEN ? = 1 THEN ? ELSE approval_id END WHERE id = ?`,
  ).bind(p.claudeTaskId !== undefined ? 1 : 0, p.claudeTaskId ?? null, p.approvalId !== undefined ? 1 : 0, p.approvalId ?? null, id).run();
}

/** `ready` to `sent`; false when it was not ready (so a second send changes nothing). */
export async function markMemoSent(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE strategy_memos SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'ready'`).bind(now, id).run());
}

/** Takes a memo back: `ready` or `sent` to `revoked`; its link stops working. */
export async function revokeMemo(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE strategy_memos SET status = 'revoked', revoked_at = ? WHERE id = ? AND status IN ('ready', 'sent')`).bind(now, id).run());
}

/** Takes a memo that never went out out of play: `collecting` or `ready` to `cancelled` (stamping `revoked_at` with when), which frees the client's one open-memo slot; false for any other state. */
export async function cancelMemo(db: D1Database, id: string, now: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE strategy_memos SET status = 'cancelled', revoked_at = ? WHERE id = ? AND status IN ('collecting', 'ready')`).bind(now, id).run());
}

/** Counts one view of the memo's link; `first_viewed_at` keeps the first one. */
export async function countMemoView(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE strategy_memos SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?) WHERE id = ?`).bind(now, id).run();
}

/** Undoes `markMemoSent` for a memo whose mail did not go out: `sent` to `ready` again (clearing `sent_at`), so the approval can be approved once more. False when it was not `sent`. */
export async function unmarkMemoSent(db: D1Database, id: string): Promise<boolean> {
  return changed(await db.prepare(`UPDATE strategy_memos SET status = 'ready', sent_at = NULL WHERE id = ? AND status = 'sent'`).bind(id).run());
}
