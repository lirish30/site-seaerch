import { describe, it, expect } from "vitest";
import { runPageSpeed, RateLimitedError } from "../src/worker/pagespeed";
import psi from "./fixtures/psi.json";

describe("runPageSpeed", () => {
  it("maps lighthouse JSON to facts and calls mobile strategy", async () => {
    let called = "";
    const r = await runPageSpeed("https://ace.com/", {
      apiKey: "K", fetch: async (u) => { called = u; return Response.json(psi); },
    });
    expect(called).toContain("strategy=mobile");
    expect(called).toContain("key=K");
    expect(called).toContain(encodeURIComponent("https://ace.com/"));
    expect(r.facts).toEqual({ performanceScore: 34, lcpMs: 8413, cls: 0.31, mobileFriendly: false });
  });

  it("missing font-size/tap-targets audits → mobileFriendly true when viewport passes", async () => {
    const r = await runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => Response.json({
      lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {
        "largest-contentful-paint": { numericValue: 1000 }, "cumulative-layout-shift": { numericValue: 0 }, viewport: { score: 1 } } } }) });
    expect(r.facts.mobileFriendly).toBe(true);
  });

  it("429 → RateLimitedError", async () => {
    await expect(runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => new Response("", { status: 429 }) }))
      .rejects.toBeInstanceOf(RateLimitedError);
  });

  it("500 → Error with status", async () => {
    await expect(runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => new Response("boom", { status: 500 }) }))
      .rejects.toThrow(/500/);
  });

  it.each([
    ["missing lighthouseResult", {}],
    ["runtimeError present", { lighthouseResult: { runtimeError: { code: "FAILED_DOCUMENT_REQUEST", message: "x" },
      categories: { performance: { score: null } }, audits: {} } }],
    ["null performance score", { lighthouseResult: { categories: { performance: { score: null } }, audits: {} } }],
    ["missing performance category", { lighthouseResult: { categories: {}, audits: {} } }],
  ])("%s → plain Error (not a 0 score, not rate limited)", async (_name, body) => {
    const p = runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => Response.json(body) });
    await expect(p).rejects.toThrow(/Lighthouse/);
    await expect(p).rejects.not.toBeInstanceOf(RateLimitedError);
  });
});
