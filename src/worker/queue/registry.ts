import type { z } from "zod";
import type { Env } from "../env";
import type { ClaudeTask } from "./db";

/** One piece of what Claude is shown: copied from a website or an inbox, so it is always delivered inside the untrusted block. */
export type QueuePart = { type: "text"; text: string } | { type: "image"; r2Key: string; mimeType: "image/jpeg" };

/** What `apply` can ask the queue to log (the agent-actions feed), in place of the default one-line summary. */
export interface ApplyLog { summary: string; recordType?: string; recordId?: string }
export type ApplyOutcome = { stale: string } | { log?: ApplyLog } | void;

/**
 * One kind of work Claude does. The queue knows nothing about a kind beyond this: `payload` and `result` are its two contracts, `build` turns a
 * payload into what Claude reads, and `apply` is the only code that ever acts on what Claude sent back.
 *
 *  - `build` returns the fixed `instructions` (trusted text the app wrote, never anything scraped) and the `untrusted` parts (everything copied
 *    from a site or an email). Return `{ stale }` when the target is gone. `task` is the claimed row, for a kind that must close it itself.
 *  - `apply` validates nothing (the result schema already did). It runs under a lease: `completeTask` takes it atomically first, so two sessions
 *    completing the same task (one stalled, one reclaimed it) never both run `apply`. A completion that crashes mid-`apply` is still run
 *    again after the lease lapses (30 minutes), so `apply` must tolerate a crash-retry: be idempotent wherever that is cheap. Return `{ stale }` when the target changed since the task was queued: the task is marked stale, nothing more happens.
 *    Throw `TaskRefused` to refuse the result (the task stays claimed so Claude can retry) or `TaskFailed` to give the task up.
 *  - `onExpire` runs for a task nobody picked up in time (it is given the task, so a hook can tell its own task from a newer one for the same target).
 *  - `onFail` runs once for a task that ended `failed` (it was claimed `MAX_ATTEMPTS` times and never completed, it was released at the cap, or `apply`
 *    threw `TaskFailed`): after the status write, best effort (a throwing hook is logged and never breaks the claim or completion that failed the task).
 *    `task` is the failed row, so a hook can tell whether it still belongs to its target's current run. A kind whose target waits on the task (the
 *    CRO stages: the audit would wait for it forever) must implement it, as it does `onExpire`; `cro.synthesize` has to as well. It only runs when
 *    the queue function was given the whole `env` rather than a bare database.
 */
export interface TaskKindDef<P, R> {
  kind: string;
  label: string;
  suggestedModel: "haiku" | "sonnet";
  payload: z.ZodType<P>;
  result: z.ZodType<R>;
  build(env: Env, p: P, task: ClaudeTask): Promise<{ instructions: string; untrusted: QueuePart[] } | { stale: string }>;
  apply(env: Env, p: P, r: R, task: ClaudeTask): Promise<ApplyOutcome>;
  onExpire?(env: Env, p: P, task?: ClaudeTask): Promise<void>;
  onFail?(env: Env, p: P, error: string, task: ClaudeTask): Promise<void>;
}

/** Thrown from `apply` to refuse the result: `completeTask` returns the message as the error and the task stays claimed. */
export class TaskRefused extends Error {}
/** Thrown from `apply` when the task can never be completed (its target is gone): the task is marked failed with the message. */
export class TaskFailed extends Error {}

const kinds = new Map<string, TaskKindDef<any, any>>();

/** Idempotent by kind, like the approval registry: registering a kind again replaces it, so re-imports never throw. */
export function registerTaskKind<P, R>(def: TaskKindDef<P, R>): void { kinds.set(def.kind, def); }
/** For tests, which register their own kinds and must leave the registry as they found it. */
export function unregisterTaskKind(kind: string): void { kinds.delete(kind); }
export const getTaskKind = (kind: string): TaskKindDef<any, any> | undefined => kinds.get(kind);
export const registeredTaskKinds = (): string[] => [...kinds.keys()];
