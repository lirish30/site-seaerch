import { z } from "zod";
import { registerTaskKind, unregisterTaskKind, TaskFailed, type TaskKindDef, type QueuePart } from "../src/worker/queue/registry";

/** What the test kinds did, so a test can tell "applied once" from "applied twice". Reset with `resetTestKindLog`. */
export const testKindLog = { applied: [] as { kind: string; id: string; result: unknown }[], expired: [] as unknown[], failed: [] as { id: string; payload: unknown; error: string }[] };
export const resetTestKindLog = () => { testKindLog.applied = []; testKindLog.expired = []; testKindLog.failed = []; };

const EchoPayload = z.object({ n: z.number().optional(), text: z.string().optional(), images: z.array(z.string()).optional() });
const EchoResult = z.strictObject({ echo: z.string() });
type EchoPayload = z.infer<typeof EchoPayload>;

/** `test.echo`: untrusted text and images in, `{ echo }` out. Text "fail" makes `apply` give the task up; text "throw" makes its `onFail` hook throw. */
const echo: TaskKindDef<EchoPayload, z.infer<typeof EchoResult>> = {
  kind: "test.echo", label: "Echo (test)", suggestedModel: "haiku", payload: EchoPayload, result: EchoResult,
  async build(_env, p) {
    const untrusted: QueuePart[] = [];
    if (p.text !== undefined) untrusted.push({ type: "text", text: p.text });
    for (const r2Key of p.images ?? []) untrusted.push({ type: "image", r2Key, mimeType: "image/jpeg" });
    return { instructions: "Echo the text back.", untrusted };
  },
  async apply(_env, p, r, task) {
    if (p.text === "fail") throw new TaskFailed("cannot be done");
    testKindLog.applied.push({ kind: task.kind, id: task.id, result: r });
  },
  async onExpire(_env, p) { testKindLog.expired.push(p); },
  async onFail(_env, p, error, task) {
    testKindLog.failed.push({ id: task.id, payload: p, error });
    if (p.text === "throw") throw new Error("hook broke");
  },
};

const StalePayload = z.object({ buildStale: z.boolean().optional() });
const StaleResult = z.strictObject({ ok: z.boolean() });

/** `test.stale`: its `apply` always reports the target as gone; with `buildStale` its `build` does too. */
const stale: TaskKindDef<z.infer<typeof StalePayload>, z.infer<typeof StaleResult>> = {
  kind: "test.stale", label: "Stale (test)", suggestedModel: "sonnet", payload: StalePayload, result: StaleResult,
  async build(_env, p) { return p.buildStale ? { stale: "the target is gone" } : { instructions: "Say ok.", untrusted: [] }; },
  async apply(_env, _p, r, task) { testKindLog.applied.push({ kind: task.kind, id: task.id, result: r }); return { stale: "the target changed" }; },
};

export const TEST_KINDS = ["test.echo", "test.stale"] as const;
export function registerTestKinds(): void { registerTaskKind(echo); registerTaskKind(stale); }
export function unregisterTestKinds(): void { for (const k of TEST_KINDS) unregisterTaskKind(k); }
