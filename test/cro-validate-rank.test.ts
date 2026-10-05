import { describe, it, expect } from "vitest";
import { applyModeRules, factQuotes, hasTrackingGap, needsRetry, quoteFound, validateRecommendations, validateReview } from "../src/worker/cro/validate";
import { pxlScore, rankRecommendations } from "../src/worker/cro/pxl";
import { defaultScenario, scenarioRange, SCENARIO_LABEL } from "../src/worker/cro/scenario";
import type { PageReview } from "../src/worker/cro/types";
import { ev, model, rec } from "./fixtures/cro";

const ids = new Set(["E1", "E2", "E3"]);
const text = "Welcome to Our Website — we’re Boise’s   trusted plumbers. Call (208) 555-1234";

describe("quoteFound", () => {
  it("matches across curly quotes, dashes, case and whitespace", () => {
    expect(quoteFound("we're boise's trusted plumbers", [text])).toBe(true);
    expect(quoteFound("Welcome to Our Website - we're", [text])).toBe(true);
    expect(quoteFound("\"Welcome to our website\"", [text])).toBe(true);
    expect(quoteFound("Best plumbers in Idaho", [text])).toBe(false);
    expect(quoteFound("", [text])).toBe(false);
  });
});

describe("validateReview", () => {
  const review = (issues: PageReview["issues"], strengths: string[] = []): PageReview => ({ page: "p", five_second_read: { thinks_business_does: "a", would_do_next: "b" }, strengths, issues });
  const issue = (o: Partial<PageReview["issues"][number]> = {}) => ({ observation: "obs", quote: null, principle: "p", evidence_ids: ["E1"], catalog_id: null, crop_evidence_id: null, ...o });

  it("drops issues with no evidence, unknown ids or quotes not on the page; nulls bad crop ids", () => {
    const r = validateReview(review([issue(), issue({ evidence_ids: [] }), issue({ evidence_ids: ["E9"] }), issue({ quote: "Free estimates" }),
      issue({ quote: "trusted plumbers", crop_evidence_id: "E77" })]), ids, [text]);
    expect(r.review.issues).toHaveLength(2);
    expect(r.review.issues[1].crop_evidence_id).toBeNull();
    expect(r.dropped.map((d) => d.reason)).toEqual(["no evidence cited", "cites unknown evidence E9", `quote "Free estimates" is not on the page`]);
  });

  it("caps kept issues at 10 and strengths at 6 without counting the overflow as drops", () => {
    const r = validateReview(review(Array.from({ length: 14 }, () => issue()), Array.from({ length: 9 }, (_, i) => `s${i}`)), ids, [text]);
    expect(r.review.issues).toHaveLength(10);
    expect(r.review.strengths).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("validateRecommendations", () => {
  it("checks every double-quoted phrase in the observation against page text and ledger facts", () => {
    const r = validateRecommendations([
      rec({ observation: `Your headline says "Welcome to Our Website"` }),
      rec({ observation: `Your menu has "Financing" under About`, evidence_ids: ["E2"] }),
      rec({ observation: `Your button says "Get Started Today"` }),
      rec({ evidence_ids: ["E1", "E99"] }),
    ], ids, [text, `"Financing" is nested under "About" in the menu`]);
    expect(r.kept).toHaveLength(2);
    expect(r.dropped.map((d) => d.reason)).toEqual([`quote "Get Started Today" is not on the page`, "cites unknown evidence E99"]);
  });

  it("retries only when more than 40% were dropped", () => {
    expect(needsRetry(10, 4)).toBe(false);
    expect(needsRetry(10, 5)).toBe(true);
    expect(needsRetry(0, 0)).toBe(false);
  });
});

describe("applyModeRules / hasTrackingGap", () => {
  it("turns tests into fix-and-measure on low traffic except big swings", () => {
    const out = applyModeRules([rec({ mode: "test", area: "header_nav" }), rec({ mode: "test", area: "hero" }), rec({ mode: "fix" })], "low");
    expect(out.map((r) => r.mode)).toEqual(["fix_measure", "test", "fix"]);
    expect(applyModeRules([rec({ mode: "test", area: "header_nav" })], "medium")[0].mode).toBe("test");
  });

  it("flags a tracking gap only when neither analytics nor call tracking was found", () => {
    expect(hasTrackingGap([ev("E1", { family: "martech", data: { analytics: false, callTracking: false, tools: [] } })])).toBe(true);
    expect(hasTrackingGap([ev("E1", { family: "martech", data: { analytics: true, callTracking: false, tools: ["GA4"] } })])).toBe(false);
    expect(hasTrackingGap([])).toBe(false);
  });
});

describe("ranking", () => {
  const evidence = [
    ev("E1", { pageKind: "home", crop: { x: 0, y: 100, w: 100, h: 40, device: "mobile", pageIndex: 0 } }),
    ev("E2", { pageKind: "about" }), ev("E3", { pageKind: "contact" }),
  ];
  const byId = new Map(evidence.map((e) => [e.id, e]));

  it("scores six yes/no facts", () => {
    expect(pxlScore(rec({ evidence_ids: ["E1", "E3"], area: "forms", effort: "low", catalog_id: "fewer_fields" }), byId, "lead_gen_phone")).toBe(6);
    expect(pxlScore(rec({ evidence_ids: ["E2"], area: "content", effort: "high", catalog_id: "html_menu" }), byId, "lead_gen_phone")).toBe(0);
  });

  it("orders by score x impact then effort, pins tracking when there's a gap, assigns horizons and caps at 25", () => {
    const recs = [
      rec({ title: "low value", evidence_ids: ["E2"], area: "content", effort: "high", impact: "low", catalog_id: null, mode: "strategic" }),
      rec({ title: "best", evidence_ids: ["E1", "E3"], area: "forms", catalog_id: "fewer_fields" }),
      rec({ title: "tracking", evidence_ids: ["E2"], area: "tracking", effort: "medium", impact: "high", catalog_id: "tracking_plan", mode: "strategic" }),
      ...Array.from({ length: 30 }, (_, i) => rec({ title: `filler ${i}`, evidence_ids: ["E2"], area: "content", effort: "medium", impact: "medium", catalog_id: null })),
    ];
    const plain = rankRecommendations(recs, evidence, "lead_gen_phone", { trackingGap: false });
    expect(plain[0].title).toBe("best");
    expect(plain).toHaveLength(25);
    const pinned = rankRecommendations(recs, evidence, "lead_gen_phone", { trackingGap: true });
    expect(pinned.slice(0, 2).map((r) => r.title)).toEqual(["tracking", "best"]);
    expect(pinned.map((r) => r.rank)).toEqual(pinned.map((_, i) => i + 1));
    expect(pinned.slice(0, 5).every((r) => r.horizon === 30)).toBe(true);
    expect(pinned.find((r) => r.title.startsWith("filler") && r.rank > 5)!.horizon).toBe(60);
  });
});

describe("scenario", () => {
  it("defaults from the business model and computes a half-to-full lift range", () => {
    const i = defaultScenario(model());
    expect(i).toEqual({ visitors: 500, currentRate: 0.02, targetRate: 0.03, closeRate: 0.4, dealValue: 900 });
    expect(scenarioRange(i)).toEqual({ leads: [3, 5], revenue: [900, 1800] });
    expect(scenarioRange({ ...i, targetRate: 0.01 })).toEqual({ leads: [0, 0], revenue: [0, 0] });
    expect(SCENARIO_LABEL).toBe("Illustrative, based on the assumptions shown");
  });
});

describe("factQuotes", () => {
  it("keeps only the phrases a fact quotes, never the wording the code wrote around them", () => {
    expect(factQuotes(['Desktop header button: "Get a Quote"', "No guarantee or warranty wording found", 'Generic phrases used: "welcome to our website", "quality service"']))
      .toEqual(["Get a Quote", "welcome to our website", "quality service"]);
  });
});
