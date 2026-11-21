import { z } from "zod";
import type { Env } from "../env";

/**
 * One kind of work the Mac helper does. The queue knows nothing about a kind beyond this: `payload` and `result` are its two contracts, and
 * `apply` is the only code that ever acts on what the helper sent back.
 *
 *  - `inputs` and `outputs` are R2 keys, computed here by the worker and never by the helper: the helper may read only a key in `inputs` and write
 *    only a key in `outputs` (exact keys, no patterns).
 *  - `apply` runs once per job, under a lease (see `completeHelperJob`). It must tolerate a crash-retry. A result that no longer fits its target
 *    (the line was edited, the video moved on) is discarded: return normally and write nothing. Throw `HelperRefused` to refuse the result:
 *    the helper is told why and the job stays claimed so it can try again.
 *  - `onFail` runs once for a job that ended `failed` (the helper gave it up, or it was claimed `MAX_ATTEMPTS` times and never completed), and
 *    `onExpire` for one nobody picked up in time: both best effort, after the status write.
 */
export interface HelperKindDef<P, R> {
  kind: string;
  payload: z.ZodType<P>;
  result: z.ZodType<R>;
  inputs(p: P): string[];
  outputs(p: P): string[];
  apply(env: Env, p: P, r: R): Promise<void>;
  onFail?(env: Env, p: P, error: string): Promise<void>;
  onExpire?(env: Env, p: P): Promise<void>;
}

/** Thrown from `apply` to refuse the result: `completeHelperJob` returns the message and the job stays claimed. */
export class HelperRefused extends Error {}

const kinds = new Map<string, HelperKindDef<any, any>>();

/** Idempotent by kind: registering a kind again replaces it, so re-imports never throw. */
export function registerHelperKind<P, R>(def: HelperKindDef<P, R>): void { kinds.set(def.kind, def); }
/** For tests, which register their own kinds and must leave the registry as they found it. */
export function unregisterHelperKind(kind: string): void { kinds.delete(kind); }
export const getHelperKind = (kind: string): HelperKindDef<any, any> | undefined => kinds.get(kind);
export const registeredHelperKinds = (): string[] => [...kinds.keys()];
