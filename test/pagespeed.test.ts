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
    expect(r.facts).toEqual({ performanceScore: 34, lcpMs: 8413, cls: 0.31, mobileFriendly: false,
      seoScore: null, accessibilityScore: null, seoIssues: [], accessibilityIssues: [] });
  });

  it("requests performance, seo and accessibility in the one call", async () => {
    let called = "";
    let calls = 0;
    await runPageSpeed("https://ace.com/", { apiKey: "K", fetch: async (u) => { calls++; called = u; return Response.json(psi); } });
    expect(calls).toBe(1);
    for (const c of ["performance", "seo", "accessibility"]) expect(called).toContain(`category=${c}`);
  });

  describe("seo + accessibility", () => {
    const body = (lh: Record<string, unknown>) => Response.json({ lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {}, ...lh } });
    const ref = (id: string, weight = 1) => ({ id, weight });
    const run = (lh: Record<string, unknown>) => runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => body(lh) }).then((r) => r.facts);

    it("parses scores and plain-English labels for failing audits in category order", async () => {
      const facts = await run({
        categories: {
          performance: { score: 0.9 },
          seo: { score: 0.667, auditRefs: [ref("is-crawlable"), ref("document-title"), ref("meta-description"), ref("hreflang", 0), ref("tap-targets")] },
          accessibility: { score: 0.844, auditRefs: [ref("color-contrast"), ref("image-alt"), ref("aria-allowed-attr"), ref("label"), ref("button-name")] },
        },
        audits: {
          "meta-description": { score: 0 }, "document-title": { score: 1 }, "is-crawlable": { score: 0.5 },
          hreflang: { score: 0 },            // weight 0 in seo refs, so not counted
          "tap-targets": { score: 0 },       // in seo refs but unmapped
          "color-contrast": { score: 0 }, "image-alt": { score: 0.89 }, "aria-allowed-attr": { score: 0 },
          label: { score: null }, "button-name": { score: 0.9 },
          "link-name": { score: 0 },         // failing but not in any auditRefs
        },
      });
      expect(facts.seoScore).toBe(67);
      expect(facts.accessibilityScore).toBe(84);
      expect(facts.seoIssues).toEqual(["blocked from Google", "no search-results summary"]);
      expect(facts.accessibilityIssues).toEqual(["text that's hard to read against its background", "images without descriptions"]);
    });

    it("does not attribute an audit to a category whose auditRefs omit it", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [ref("document-title")] }, accessibility: { score: 0.5, auditRefs: [ref("label")] } },
        audits: { "document-title": { score: 0 }, label: { score: 0 }, "link-name": { score: 0 } },
      });
      expect(facts.seoIssues).toEqual(["no page title"]);
      expect(facts.accessibilityIssues).toEqual(["form fields without labels"]);
    });

    it("de-duplicates labels and produces no issues without auditRefs", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [ref("link-text"), ref("link-text")] }, accessibility: { score: 0.5 } },
        audits: { "link-text": { score: 0 }, "color-contrast": { score: 0 } },
      });
      expect(facts.seoIssues).toEqual(["links that just say things like 'click here'"]);
      expect(facts.accessibilityScore).toBe(50);
      expect(facts.accessibilityIssues).toEqual([]);
    });

    it("missing or null-scored seo/accessibility categories → null, never 0", async () => {
      const a = await run({ categories: { performance: { score: 0.9 } } });
      expect([a.seoScore, a.accessibilityScore]).toEqual([null, null]);
      const b = await run({ categories: { performance: { score: 0.9 }, seo: { score: null }, accessibility: {} } });
      expect([b.seoScore, b.accessibilityScore]).toEqual([null, null]);
      const c = await run({ categories: { performance: { score: 0.9 }, seo: { score: 0 } } });
      expect(c.seoScore).toBe(0);
    });
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
