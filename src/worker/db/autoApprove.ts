// Auto-approve (Plan 15): which kinds of approval go through without a click, and a log of what did.
// Times (`now`, `decidedAt`) are UTC ISO strings with milliseconds. `decidedOn` and `day` are local dates (YYYY-MM-DD) the caller worked out in the booking zone.

export type AutoRule = { kind: string; enabled: boolean; enabledAt: string | null };
export interface AutoApproval { approvalId: string; kind: string; businessId: string | null; businessName: string | null; decidedAt: string; outcome: "sent" | "failed"; error: string | null }

/** Every rule that has been switched on or off at least once, by kind. */
export async function listRules(db: D1Database): Promise<AutoRule[]> {
  const rows = (await db.prepare(`SELECT kind, enabled, enabled_at FROM auto_approve_rules ORDER BY kind`).all<{ kind: string; enabled: number; enabled_at: string | null }>()).results;
  return rows.map((r) => ({ kind: r.kind, enabled: !!r.enabled, enabledAt: r.enabled_at }));
}

/** Switches a rule on or off in one statement. Turning it on stamps `enabled_at` with `now`; turning it off clears the stamp. Turning on a rule already on restamps it. */
export async function setRule(db: D1Database, kind: string, enabled: boolean, now: string): Promise<void> {
  await db.prepare(
    `INSERT INTO auto_approve_rules (kind, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`,
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
