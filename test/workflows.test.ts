import { describe, it, expect } from "vitest";
import { adaptStep, startLeadIdempotent } from "../src/worker/workflows";

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

describe("adaptStep retry config", () => {
  const configFor = async (name: string) => {
    let cfg: any;
    const step = { do: async (_n: string, c: any, fn: any) => { cfg = c; return fn(); }, sleep: async () => {} };
    await adaptStep(step as any).do(name, async () => true);
    return cfg;
  };
  it("fetch-listings retries more patiently than other steps (Bright Data 502s come in bursts)", async () => {
    const listing = await configFor("fetch-listings");
    const other = await configFor("pagespeed");
    expect(listing.retries.limit).toBe(5);
    expect(listing.retries.delay).toBe("30 seconds");
    expect(listing.retries.backoff).toBe("exponential");
    expect(other.retries.limit).toBe(3);
    expect(other.retries.delay).toBe("10 seconds");
  });
});
