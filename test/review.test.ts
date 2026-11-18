import { describe, it, expect } from "vitest";
import { buildReviewContent, normalizeReview, ReviewOutput, REVIEW_INSTRUCTIONS, type ReviewInput } from "../src/worker/audit/review";

const input: ReviewInput = {
  business: { name: "Ace", category: "Plumber", address: "Boise", website: "https://ace.com/" },
  facts: null, pagespeedScore: 40, desktopKey: "shots/b1/d.jpg", mobileKey: null,
};
const valid = { niche: "trades", value_proposition: "v", scores: { design: 70, content: 60, cro: 50, mobile: 65 },
  summaries: { design: "", content: "", cro: "", mobile: "" }, strengths: [], niche_checklist: [], findings: [] };

describe("ReviewOutput", () => {
  it("accepts a valid review and refuses malformed ones", () => {
    expect(ReviewOutput.safeParse(valid).success).toBe(true);
    expect(ReviewOutput.safeParse({ nope: 1 }).success).toBe(false);
    expect(ReviewOutput.safeParse({ ...valid, scores: { ...valid.scores, design: 101 } }).success).toBe(false);
    expect(ReviewOutput.safeParse({ ...valid, findings: [{ category: "speed", severity: "nice", title: "t", evidence: "e", recommendation: "r" }] }).success).toBe(false);
  });
});

describe("ReviewOutput text limits", () => {
  const finding = { category: "cro", severity: "nice", title: "t", evidence: "e", recommendation: "r" };
  const paths = (r: unknown) => { const x = ReviewOutput.safeParse(r); return x.success ? [] : x.error.issues.map((i) => i.path.join(".")); };

  it("accepts text up to each limit", () => {
    const ok = { ...valid, value_proposition: "v".repeat(1000), summaries: { design: "s".repeat(1000), content: "", cro: "", mobile: "" },
      findings: [{ ...finding, title: "t".repeat(300), evidence: "e".repeat(1000), recommendation: "r".repeat(1000) }] };
    expect(ReviewOutput.safeParse(ok).success).toBe(true);
  });

  it("refuses an over-long value, naming where it is", () => {
    expect(paths({ ...valid, value_proposition: "v".repeat(1001) })).toEqual(["value_proposition"]);
    expect(paths({ ...valid, summaries: { ...valid.summaries, cro: "s".repeat(1001) } })).toEqual(["summaries.cro"]);
    expect(paths({ ...valid, findings: [{ ...finding, title: "t".repeat(301) }] })).toEqual(["findings.0.title"]);
    expect(paths({ ...valid, findings: [{ ...finding, evidence: "e".repeat(1001) }] })).toEqual(["findings.0.evidence"]);
    expect(paths({ ...valid, findings: [{ ...finding, recommendation: "r".repeat(1001) }] })).toEqual(["findings.0.recommendation"]);
  });
});

describe("normalizeReview", () => {
  it("maps an unknown niche to general and keeps a known one", () => {
    expect(normalizeReview({ ...valid, niche: "spaceships" }).niche).toBe("general");
    expect(normalizeReview(valid).niche).toBe("trades");
    expect(normalizeReview(valid).scores.design).toBe(70);
  });
});

describe("buildReviewContent", () => {
  it("sends only the screenshots it has, as stored keys, with business details last", () => {
    const c = buildReviewContent(input);
    expect(c.filter((x) => x.type === "image")).toEqual([{ type: "image", r2Key: "shots/b1/d.jpg", mimeType: "image/jpeg" }]);
    expect(c.at(-1)).toMatchObject({ type: "text" });
    expect((c.at(-1) as { text: string }).text).toContain("Google mobile speed score: 40/100");
    expect(buildReviewContent({ ...input, mobileKey: "shots/b1/m.jpg" }).filter((x) => x.type === "image")).toHaveLength(2);
  });

  it("says so when the site could not be crawled", () => {
    expect((buildReviewContent(input).at(-1) as { text: string }).text).toContain("could not be crawled");
  });
});

describe("REVIEW_INSTRUCTIONS", () => {
  it("asks for the result through the queue, not through a tool call", () => {
    expect(REVIEW_INSTRUCTIONS).toContain("Return the result with complete_claude_task.");
    expect(REVIEW_INSTRUCTIONS).not.toMatch(/submit_review/);
    expect(REVIEW_INSTRUCTIONS).toContain("Scoring guide");
  });
});
