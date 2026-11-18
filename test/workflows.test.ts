import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { adaptStep, depsFromEnv, startLeadIdempotent } from "../src/worker/workflows";

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

describe("depsFromEnv", () => {
  it("has no AI caller: the site review and the draft are queued work for Claude Code, not an API call", () => {
    const d = depsFromEnv(env);
    expect(Object.keys(d).sort()).toEqual(["db", "fetch", "now", "pagespeedKey", "raw", "render"]);
  });
});

describe("adaptStep retry config", () => {
  const configFor = async (name: string) => {
    let cfg: any;
    const step = { do: async (_n: string, c: any, fn: any) => { cfg = c; return fn(); }, sleep: async () => {} };
    await adaptStep(step as any).do(name, async () => true);
    return cfg;
  };
  it("fetch-listings backs off longer than other steps but gives up within minutes, not tens of minutes", async () => {
    for (const name of ["fetch-listings", "fetch-listings-1", "fetch-listings-2"]) {
      const listing = await configFor(name);
      expect(listing.retries.limit).toBe(3);
      expect(listing.retries.delay).toBe("20 seconds");
      expect(listing.retries.backoff).toBe("exponential");
      expect(listing.timeout).toBe("5 minutes");
    }
    const other = await configFor("pagespeed");
    expect(other.retries.limit).toBe(3);
    expect(other.retries.delay).toBe("10 seconds");
  });
  it("gives every step the default 5 minute timeout: the Claude stages run on the queue, not in workflow steps", async () => {
    for (const name of ["capture-0", "evidence", "pagespeed", "review", "start-stages", "model", "page-0", "synthesize"]) {
      const c = await configFor(name);
      expect(c.timeout).toBe("5 minutes");
      expect(c.retries.limit).toBe(3);
    }
  });
});
