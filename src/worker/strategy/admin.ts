import { reject } from "../approvals/decide";
import { cancelMemo, getMemo, revokeMemo, type StrategyMemo, type StrategyStatus } from "../db/strategy";
import type { Env } from "../env";
import { cancelTasksFor } from "../queue/db";
import { STRATEGY_TARGET, StrategyMemoResult } from "../queue/strategyMemo";
import { strategyLink } from "./mail";

// What the owner does with a client's strategy memos (Plan 16): reads the list, cancels one that has not gone out, takes one back. The mirror of the Local SEO report's admin. A memo that is cancelled or taken
// back also takes back its queued Claude task and its pending approval, so nothing is left waiting for a memo that will never go out.

/** One memo as the owner's list shows it. The token is never a field: `link` is the whole address and only a sent memo has one. The facts and the Claude task id never leave the server. */
export interface MemoRow {
  id: string; version: number; status: StrategyStatus; test: boolean; createdAt: string; readyAt: string | null; sentAt: string | null; viewCount: number; firstViewedAt: string | null;
  link: string | null;
  /** Claude's words; null until there are some (and for a memo that never got any). */
  body: StrategyMemoResult | null;
  approvalId: string | null;
}

export function memoRow(env: Env, m: StrategyMemo): MemoRow {
  const body = StrategyMemoResult.safeParse(m.body);
  return {
    id: m.id, version: m.version, status: m.status, test: m.test, createdAt: m.createdAt, readyAt: m.readyAt, sentAt: m.sentAt, viewCount: m.viewCount, firstViewedAt: m.firstViewedAt,
    link: m.status === "sent" ? strategyLink(env, m.token) : null, body: body.success ? body.data : null, approvalId: m.approvalId,
  };
}

const STATE: Record<StrategyStatus, string> = {
  collecting: "still being written", ready: "waiting for your approval", sent: "already sent", revoked: "already taken back", cancelled: "already cancelled",
};

export type MemoDone = { ok: true; memo: StrategyMemo } | { ok: false; status: 404 | 409; error: string };
const NOT_FOUND: MemoDone = { ok: false, status: 404, error: "not found" };

/** Takes back the memo's queued Claude task and rejects its pending approval (an approval already decided stays as it was). */
async function settle(env: Env, memo: StrategyMemo, note: string): Promise<void> {
  await cancelTasksFor(env.DB, STRATEGY_TARGET, memo.id);
  if (memo.approvalId) await reject(env.DB, memo.approvalId, note);
}

/** The memo of this client, or null: another client's memo is never found through this client. */
async function memoOf(env: Env, businessId: string, memoId: string): Promise<StrategyMemo | null> {
  const memo = await getMemo(env.DB, memoId);
  return memo && memo.businessId === businessId ? memo : null;
}

/** Cancels a memo that has not gone out (`collecting` or `ready`): it stops being the client's open memo, its Claude task is closed and its pending approval rejected. */
export async function cancelMemoNow(env: Env, businessId: string, memoId: string, now: Date): Promise<MemoDone> {
  const memo = await memoOf(env, businessId, memoId);
  if (!memo) return NOT_FOUND;
  if (!(await cancelMemo(env.DB, memo.id, now.toISOString()))) return { ok: false, status: 409, error: `Only a memo that is being written or waiting for approval can be cancelled, and this one is ${STATE[memo.status]}.` };
  await settle(env, memo, "the memo was cancelled");
  return { ok: true, memo: (await getMemo(env.DB, memo.id))! };
}

/** Takes back a `ready` or `sent` memo: its link stops working, its Claude task is closed and its pending approval is rejected. */
export async function revokeMemoNow(env: Env, businessId: string, memoId: string, now: Date): Promise<MemoDone> {
  const memo = await memoOf(env, businessId, memoId);
  if (!memo) return NOT_FOUND;
  if (!(await revokeMemo(env.DB, memo.id, now.toISOString()))) return { ok: false, status: 409, error: `Only a ready or sent memo can be revoked, and this one is ${STATE[memo.status]}.` };
  await settle(env, memo, "the memo was revoked");
  return { ok: true, memo: (await getMemo(env.DB, memo.id))! };
}
