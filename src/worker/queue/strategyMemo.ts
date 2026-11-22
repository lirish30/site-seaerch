import type { Env } from "../env";

/**
 * Asks Claude for the words of a strategy memo (Plan 16). Task 10 gives this its body: it registers the `strategy.memo` Claude task kind and its result schema, queues the task for the memo and records it
 * on the row (`setMemoLinks`). Until then it does nothing, so a memo made now stays `collecting`. `startStrategyMemo` calls it once the memo row exists and has no task yet.
 */
export async function queueStrategyMemo(env: Env, memoId: string): Promise<void> {
  void env;
  void memoId;
}
