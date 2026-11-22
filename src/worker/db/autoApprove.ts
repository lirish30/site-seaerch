// Auto-approve (Plan 15): which kinds of approval go through without a click, and a log of what did.
// Times (`now`, `decidedAt`) are UTC ISO strings with milliseconds. `decidedOn` and `day` are local dates (YYYY-MM-DD) the caller worked out in the booking zone.

export type AutoRule = { kind: string; enabled: boolean; enabledAt: string | null };
export interface AutoApproval { approvalId: string; kind: string; businessId: string | null; businessName: string | null; decidedAt: string; outcome: "sent" | "failed"; error: string | null }

/** Every rule that has been switched on or off at least once, by kind. */
export async function listRules(db: D1Database): Promise<AutoRule[]> {
  const rows = (await db.prepare(`SELECT kind, enabled, enabled_at FROM auto_approve_rules ORDER BY kind`).all<{ kind: string; enabled: number; enabled_at: string | null }>()).results;
  return rows.map((r) => ({ kind: r.kind, enabled: !!r.enabled, enabledAt: r.enabled_at }));
}

/** Switches a rule on or off in one statement. Turning it on stamps `enabled_at` with `now`; turning it off clears the stamp. Turning on a rule that is already on keeps its first stamp: `enabled_at` is the cutoff (only approvals made at or after it are auto-approved), so a repeated save must never move it forward. */
export async function setRule(db: D1Database, kind: string, enabled: boolean, now: string): Promise<void> {
  await db.prepare(
    `INSERT INTO auto_approve_rules (kind, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at,
       enabled_at = CASE WHEN auto_approve_rules.enabled = 1 AND excluded.enabled = 1 THEN COALESCE(auto_approve_rules.enabled_at, excluded.enabled_at) ELSE excluded.enabled_at END`,
  ).bind(kind, enabled ? 1 : 0, enabled ? now : null, now).run();
}

/** Logs an approval that went through unclicked; a second call for the same approval replaces the first. */
export async function recordAutoApproval(
  db: D1Database, r: { approvalId: string; kind: string; businessId: string | null; decidedAt: string; decidedOn: string; outcome: "sent" | "failed"; error?: string },
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO auto_approvals (approval_id, kind, business_id, decided_at, decided_on, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(r.approvalId, r.kind, r.businessId, r.decidedAt, r.decidedOn, r.outcome, r.error ?? null).run();
}

/**
 * Takes one of the day's `cap` places for an approval about to be sent, in ONE statement (the count and the insert are atomic, so two sweeps at once can never pass the cap together). The row says `failed` / "sending"
 * until `recordAutoApproval` replaces it with the real outcome, so a crash between the two leaves an honest line and a used place. False when the day is full or this approval already has a row.
 */
export async function reserveAutoApproval(
  db: D1Database, r: { approvalId: string; kind: string; businessId: string | null; decidedAt: string; decidedOn: string }, cap: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO auto_approvals (approval_id, kind, business_id, decided_at, decided_on, outcome, error)
     SELECT ?1, ?2, ?3, ?4, ?5, 'failed', 'sending' WHERE (SELECT COUNT(*) FROM auto_approvals WHERE decided_on = ?5) < ?6`,
  ).bind(r.approvalId, r.kind, r.businessId, r.decidedAt, r.decidedOn, cap).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Gives a reserved place back (the approval was decided by a person before the send began, so nothing was attempted). Only a row still saying "sending" is removed. */
export async function releaseAutoApproval(db: D1Database, approvalId: string): Promise<void> {
  await db.prepare(`DELETE FROM auto_approvals WHERE approval_id = ? AND outcome = 'failed' AND error = 'sending'`).bind(approvalId).run();
}

/** How many approvals were decided unclicked on the local day. */
export async function countAutoApprovalsOn(db: D1Database, day: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM auto_approvals WHERE decided_on = ?`).bind(day).first<{ n: number }>())!.n;
}

/** The latest unclicked approvals, newest first, with the client's name when there is one. */
export async function listAutoApprovals(db: D1Database, limit: number): Promise<AutoApproval[]> {
  const rows = (await db.prepare(
    `SELECT a.approval_id, a.kind, a.business_id, b.name AS business_name, a.decided_at, a.outcome, a.error
       FROM auto_approvals a LEFT JOIN businesses b ON b.id = a.business_id ORDER BY a.decided_at DESC, a.rowid DESC LIMIT ?`,
  ).bind(limit).all<{ approval_id: string; kind: string; business_id: string | null; business_name: string | null; decided_at: string; outcome: "sent" | "failed"; error: string | null }>()).results;
  return rows.map((r) => ({ approvalId: r.approval_id, kind: r.kind, businessId: r.business_id, businessName: r.business_name, decidedAt: r.decided_at, outcome: r.outcome, error: r.error }));
}
