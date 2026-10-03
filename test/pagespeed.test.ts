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
      seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] });
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
    const ref = (id: string, weight = 1, group = "") => ({ id, weight, group });
    // Lighthouse audits are mostly binary (0 or 1) with a scoreDisplayMode.
    const fail = (group?: string) => ({ score: 0, scoreDisplayMode: "binary", ...(group ? { group } : {}) });
    const pass = { score: 1, scoreDisplayMode: "binary" };
    const run = (lh: Record<string, unknown>) => runPageSpeed("https://a.com/", { apiKey: "K", fetch: async () => body(lh) }).then((r) => r.facts);

    it("parses scores and returns failing audit ids sorted by weight (desc, stable)", async () => {
      const facts = await run({
        categories: {
          performance: { score: 0.9 },
          seo: { score: 0.667, auditRefs: [ref("is-crawlable", 4), ref("document-title", 1), ref("meta-description", 1), ref("hreflang", 0), ref("tap-targets", 1)] },
          accessibility: { score: 0.844, auditRefs: [ref("aria-allowed-attr", 10), ref("color-contrast", 7), ref("image-alt", 10), ref("label", 7), ref("button-name", 10)] },
        },
        audits: {
          "meta-description": fail(), "document-title": pass, "is-crawlable": fail(),
          hreflang: fail(),                  // weight 0 in seo refs, so not counted
          "tap-targets": fail(),
          "color-contrast": fail("a11y-color-contrast"), "image-alt": fail(), "aria-allowed-attr": fail(), label: { score: null, scoreDisplayMode: "notApplicable" },
          "button-name": pass,
          "link-name": fail(),               // failing but not in any auditRefs
        },
      });
      expect(facts.seoScore).toBe(67);
      expect(facts.accessibilityScore).toBe(84);
      expect(facts.seoIssueIds).toEqual(["is-crawlable", "meta-description", "tap-targets"]);
      // image-alt (10) before color-contrast (7); alphabetical input order must not decide
      expect(facts.accessibilityIssueIds).toEqual(["aria-allowed-attr", "image-alt", "color-contrast"]);
    });

    it("score just under 0.9 fails, 0.9 passes", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [ref("link-text"), ref("canonical")] } },
        audits: { "link-text": { score: 0.89, scoreDisplayMode: "numeric" }, canonical: { score: 0.9, scoreDisplayMode: "numeric" } },
      });
      expect(facts.seoIssueIds).toEqual(["link-text"]);
    });

    it("does not attribute an audit to a category whose auditRefs omit it", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [ref("document-title")] }, accessibility: { score: 0.5, auditRefs: [ref("label")] } },
        audits: { "document-title": fail(), label: fail(), "link-name": fail() },
      });
      expect(facts.seoIssueIds).toEqual(["document-title"]);
      expect(facts.accessibilityIssueIds).toEqual(["label"]);
    });

    it("de-duplicates ids and produces no issues without auditRefs", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [ref("link-text"), ref("link-text")] }, accessibility: { score: 0.5 } },
        audits: { "link-text": fail(), "color-contrast": fail() },
      });
      expect(facts.seoIssueIds).toEqual(["link-text"]);
      expect(facts.accessibilityScore).toBe(50);
      expect(facts.accessibilityIssueIds).toEqual([]);
    });

    it("tolerates null auditRefs entries and a missing audits object", async () => {
      const facts = await run({
        categories: { performance: { score: 0.9 }, seo: { score: 0.5, auditRefs: [null, undefined, { weight: 1 }, ref("document-title")] }, accessibility: { score: 0.5, auditRefs: "nope" } },
        audits: undefined,
      });
      expect(facts.seoIssueIds).toEqual([]);
      expect(facts.accessibilityIssueIds).toEqual([]);
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
