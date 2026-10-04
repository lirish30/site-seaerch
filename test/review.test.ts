import { describe, it, expect } from "vitest";
import { reviewSite, buildReviewContent, type ReviewInput } from "../src/worker/audit/review";

const input: ReviewInput = {
  business: { name: "Ace", category: "Plumber", address: "Boise", website: "https://ace.com/" },
  facts: null, pagespeedScore: 40, desktopJpegB64: "AAAA", mobileJpegB64: null,
};
const valid = { niche: "trades", value_proposition: "v", scores: { design: 70, content: 60, cro: 50, mobile: 65 },
  summaries: { design: "", content: "", cro: "", mobile: "" }, strengths: [], niche_checklist: [], findings: [] };

describe("reviewSite", () => {
  it("retries once on malformed output, then returns the validated review", async () => {
    let calls = 0;
    const r = await reviewSite(input, async () => (++calls === 1 ? { nope: 1 } : valid));
    expect(calls).toBe(2);
    expect(r?.scores.design).toBe(70);
  });

  it("returns null after two bad outputs, and maps unknown niches to general", async () => {
    expect(await reviewSite(input, async () => null)).toBeNull();
    expect((await reviewSite(input, async () => ({ ...valid, niche: "spaceships" })))?.niche).toBe("general");
  });

  it("sends only the screenshots it has, with business details last", () => {
    const c = buildReviewContent(input);
    expect(c.filter((x) => x.type === "image")).toHaveLength(1);
    expect(c.at(-1)).toMatchObject({ type: "text" });
    expect((c.at(-1) as any).text).toContain("Google mobile speed score: 40/100");
  });

  it("skips the call entirely when there is nothing to look at", async () => {
    let called = false;
    expect(await reviewSite({ ...input, desktopJpegB64: null }, async () => { called = true; return valid; })).toBeNull();
    expect(called).toBe(false);
  });
});
