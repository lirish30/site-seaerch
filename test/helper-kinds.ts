import { z } from "zod";
import { registerHelperKind, unregisterHelperKind, type HelperKindDef } from "../src/worker/helper/kinds";

/** What the test kinds did, so a test can tell "applied once" from "applied twice". Reset with `resetHelperKindLog`. */
export const helperKindLog = { applied: [] as { kind: string; payload: unknown; result: unknown }[], failed: [] as { payload: unknown; error: string }[], expired: [] as unknown[] };
export const resetHelperKindLog = () => { helperKindLog.applied = []; helperKindLog.failed = []; helperKindLog.expired = []; };

const Payload = z.object({ n: z.number().optional() });
const Result = z.strictObject({ ok: z.boolean() });
type P = z.infer<typeof Payload>;

/** `test.helper`: a payload and a `{ ok }` result. It reads `in/test.bin` and may write `out/test.bin` and nothing else. */
const def: HelperKindDef<P, z.infer<typeof Result>> = {
  kind: "test.helper",
  payload: Payload,
  result: Result,
  inputs: () => ["in/test.bin"],
  outputs: () => ["out/test.bin"],
  async apply(_env, p, r) { helperKindLog.applied.push({ kind: "test.helper", payload: p, result: r }); },
  async onFail(_env, p, error) { helperKindLog.failed.push({ payload: p, error }); },
  async onExpire(_env, p) { helperKindLog.expired.push(p); },
};

export const registerHelperTestKinds = () => registerHelperKind(def);
export const unregisterHelperTestKinds = () => unregisterHelperKind(def.kind);
