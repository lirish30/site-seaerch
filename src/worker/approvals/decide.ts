import type { Env } from "../env";
import { toApproval } from "../db/approvals";
import { getHandler } from "./registry";

export type ApproveResult = { ok: true } | { ok: false; error: string; status: 404 | 409 | 422 | 502 };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Claim first, then act: the conditional UPDATE is the double-approve guard, so only one caller
 * ever reaches `execute`. On any failure after the claim the row goes back to pending with `error`.
 */
export async function approve(env: Env, id: string, edited?: unknown): Promise<ApproveResult> {
  const db = env.DB;
  const claimed = await db.prepare(`UPDATE approvals SET status = 'approved', decided_at = ?, error = NULL WHERE id = ? AND status = 'pending' RETURNING *`)
    .bind(new Date().toISOString(), id).first<Parameters<typeof toApproval>[0]>();
  if (!claimed) {
    const exists = await db.prepare(`SELECT 1 AS x FROM approvals WHERE id = ?`).bind(id).first();
    return exists ? { ok: false, error: "already decided", status: 409 } : { ok: false, error: "approval not found", status: 404 };
  }
  const restore = (error: string) =>
    db.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL, error = ? WHERE id = ?`).bind(error, id).run();

  const a = toApproval(claimed);
  const handler = getHandler(a.kind);
  if (!handler) { const error = `no handler for kind ${a.kind}`; await restore(error); return { ok: false, error, status: 422 }; }

  let payload: unknown;
  try { payload = handler.parse(edited !== undefined ? edited : a.payload); }
  catch (e) { const error = msg(e); await restore(error); return { ok: false, error, status: 422 }; }

  if (edited !== undefined) {
    await db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).bind(JSON.stringify(edited), id).run();
    a.payload = edited;
  }
  try { await handler.execute(env, payload, a); }
  catch (e) { const error = msg(e); await restore(error); return { ok: false, error, status: 502 }; }
  return { ok: true };
}

/** False when the approval is unknown or already decided. */
export async function reject(db: D1Database, id: string, note?: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ?, decision_note = ?, error = NULL WHERE id = ? AND status = 'pending'`)
    .bind(new Date().toISOString(), note ?? null, id).run();
  return (r.meta.changes ?? 0) > 0;
}
