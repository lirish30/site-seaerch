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
 *  - `apply` validates nothing (the result schema already did) and must be safe to run twice: a completion that crashed after its effects is run
 *    again. Return `{ stale }` when the target changed since the task was queued: the task is marked stale, nothing more happens.
 *    Throw `TaskRefused` to refuse the result (the task stays claimed so Claude can retry) or `TaskFailed` to give the task up.
 *  - `onExpire` runs for a task nobody picked up in time.
 */
export interface TaskKindDef<P, R> {
  kind: string;
  label: string;
  suggestedModel: "haiku" | "sonnet";
  payload: z.ZodType<P>;
  result: z.ZodType<R>;
  build(env: Env, p: P, task: ClaudeTask): Promise<{ instructions: string; untrusted: QueuePart[] } | { stale: string }>;
  apply(env: Env, p: P, r: R, task: ClaudeTask): Promise<ApplyOutcome>;
  onExpire?(env: Env, p: P): Promise<void>;
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
