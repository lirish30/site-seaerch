import { describe, it, expect } from "vitest";
import { startLeadIdempotent } from "../src/worker/workflows";

const P = { businessId: "b1", searchId: "s1" };

describe("startLeadIdempotent", () => {
  it("create ok → creates with deterministic id", async () => {
    const ids: string[] = [];
    await startLeadIdempotent({ create: async (o: any) => { ids.push(o.id); return {} as any; }, get: async () => { throw new Error("no"); } } as any, P);
    expect(ids).toEqual(["lead-s1-b1"]);
  });
  it("create throws but instance exists → no throw", async () => {
    await expect(startLeadIdempotent({ create: async () => { throw new Error("already exists"); }, get: async () => ({}) as any } as any, P)).resolves.toBeUndefined();
  });
  it("create throws and get fails → rethrows", async () => {
    await expect(startLeadIdempotent({ create: async () => { throw new Error("already exists"); }, get: async () => { throw new Error("not found"); } } as any, P)).rejects.toThrow(/already exists/);
  });
});
