import { describe, it, expect } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { CroFatalError } from "../src/worker/cro/ai";
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
  it("gives the AI steps (business model, each page, the roadmap) a 10 minute timeout and leaves the rest at 5", async () => {
    for (const name of ["model", "page-0", "page-6", "synthesize"]) expect((await configFor(name)).timeout).toBe("10 minutes");
    for (const name of ["capture-0", "evidence", "pagespeed", "review", "fetch-listings"]) expect((await configFor(name)).timeout).toBe("5 minutes");
    expect((await configFor("synthesize")).retries.limit).toBe(3);
  });

  it("turns a fatal AI error into a NonRetryableError so Workflows fails the step straight away; other errors keep retrying", async () => {
    const step = { do: async (_n: string, _c: any, fn: any) => fn(), sleep: async () => {} };
    const run = (e: Error) => adaptStep(step as any).do("synthesize", async () => { throw e; });
    const fatal = await run(new CroFatalError("Claude declined to review this site")).catch((e) => e);
    expect(fatal).toBeInstanceOf(NonRetryableError);
    expect(fatal.message).toBe("Claude declined to review this site");
    const transient = await run(new Error("HTTP 529")).catch((e) => e);
    expect(transient).not.toBeInstanceOf(NonRetryableError);
    expect(transient.message).toBe("HTTP 529");
  });
});
