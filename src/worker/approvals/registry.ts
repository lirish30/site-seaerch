import type { Env } from "../env";
import type { Approval } from "../db/approvals";

/**
 * One approvable action. `parse` validates (and normalises) a payload; `execute` does the outbound work.
 *
 * Contract: `execute` must be idempotent, or must durably record its side effect (for example "sent") before any step
 * that can throw. approve() restores the row to pending on any throw, so a handler that already did part of its work
 * (sent an email, then failed to record it) would repeat that side effect when the approval is retried.
 */
export interface ApprovalHandler<P> {
  kind: string;
  label: string;
  parse(payload: unknown): P;
  execute(env: Env, payload: P, a: Approval): Promise<void>;
}

const handlers = new Map<string, ApprovalHandler<any>>();

/** Idempotent by kind: registering the same kind again replaces it, so re-imports never throw. */
export function registerHandler(h: ApprovalHandler<any>): void {
  handlers.set(h.kind, h);
}
export const getHandler = (kind: string): ApprovalHandler<any> | undefined => handlers.get(kind);
export const registeredKinds = (): string[] => [...handlers.keys()];
