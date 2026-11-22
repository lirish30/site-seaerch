import { isClient } from "../clients/record";
import { getMemo, insertMemo, listMemos, type StrategyMemo } from "../db/strategy";
import { newClientToken } from "../documents/token";
import type { Env } from "../env";
import { queueStrategyMemo } from "../queue/strategyMemo";
import { buildMemoFacts, MemoRefused } from "./facts";

/**
 * Starts a client's strategy memo (Plan 16): the facts are frozen into a new row and Claude is asked for the words. A client has one open memo at a time: while one is `collecting` or `ready`, a second
 * call returns it with `created: false` and builds nothing (it only asks Claude again when that memo has no task yet). The business must be a real client unless `test` (a rehearsal). Throws `MemoRefused`
 * for a lead and for a client with nothing measured.
 */
export async function startStrategyMemo(env: Env, businessId: string, o: { now: Date; test?: boolean }): Promise<{ memo: StrategyMemo; created: boolean }> {
  const db = env.DB;
  if (!o.test && !(await isClient(db, businessId))) throw new MemoRefused("Only a client can get a strategy memo.");
  let { memo, created } = await openOrNew(env, businessId, o);
  if (memo.status === "collecting" && !memo.claudeTaskId) {
    await queueStrategyMemo(env, memo.id);
    memo = (await getMemo(db, memo.id)) ?? memo;
  }
  return { memo, created };
}

/** The client's open memo, or a new one built from the numbers as they are now (an open memo's facts are frozen, so a second call does not read them again). */
async function openOrNew(env: Env, businessId: string, o: { now: Date; test?: boolean }): Promise<{ memo: StrategyMemo; created: boolean }> {
  const open = (await listMemos(env.DB, businessId)).find((m) => m.status === "collecting" || m.status === "ready");
  if (open) return { memo: open, created: false };
  const facts = await buildMemoFacts(env, businessId, o.now);
  return insertMemo(env.DB, { businessId, token: newClientToken(), facts, test: !!o.test, now: o.now.toISOString() });
}
