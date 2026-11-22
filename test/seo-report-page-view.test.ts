import { describe, expect, it } from "vitest";
import { cellText, seoReportPageView, type PublicSeoReport } from "../src/client/seoReportPageView";

const nine = (top: number) => Array.from({ length: 9 }, (_, i) => ({ pos: i < top ? 2 : 9, ok: true }));
const page = (over: Partial<PublicSeoReport> = {}): PublicSeoReport => ({
  clientName: "Ace Plumbing", label: "November 2026", summary: "In our check the business showed up at two points.", recommendation: "Ask for reviews.",
  priorities: ["Answer the low review", "Fix the address", "Publish the water heater page"], rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
  terms: [
    { term: "drain cleaning", town: "Tigard", points: nine(2), measured: 9, visible: 2, previousVisible: 5 },
    { term: "water heater repair", town: null, points: [...nine(3).slice(0, 6), { pos: null, ok: false }, { pos: null, ok: false }, { pos: null, ok: false }], measured: 6, visible: null, previousVisible: null },
  ],
  gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 }, reviews: { seen: 3, posted: 2 },
  content: { published: [{ kind: "page", title: "Drain cleaning in Tigard" }, { kind: "gbp_post", title: "<b>Winter</b> tips" }] }, citations: { listed: 6, needsFix: 2, todo: 4 }, sentOn: "2026-12-01",
  ...over,
});
const view = (over: Partial<PublicSeoReport> = {}) => { const p = page(over); return seoReportPageView(p, { summary: p.summary, recommendation: p.recommendation, priorities: p.priorities }); };
/** Every string in the view model. */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe("cellText", () => {
  it("reads a position as the band it is in, and the other states plainly", () => {
    expect(cellText({ pos: 1, ok: true })).toBe("1-3");
    expect(cellText({ pos: 2, ok: true })).toBe("1-3");
    expect(cellText({ pos: 3, ok: true })).toBe("1-3");
    expect(cellText({ pos: 4, ok: true })).toBe("4-10");
    expect(cellText({ pos: 7, ok: true })).toBe("4-10");
    expect(cellText({ pos: 10, ok: true })).toBe("4-10");
    expect(cellText({ pos: 11, ok: true })).toBe("11-20");
    expect(cellText({ pos: 15, ok: true })).toBe("11-20");
    expect(cellText({ pos: 20, ok: true })).toBe("11-20");
    expect(cellText({ pos: 21, ok: true })).toBe("not in the top 20");
    expect(cellText({ pos: null, ok: true })).toBe("not in the top 20");
    expect(cellText({ pos: null, ok: false })).toBe("not checked");
    expect(cellText({ pos: 2, ok: false })).toBe("not checked");
  });
});

describe("seoReportPageView", () => {
  it("has no 'Reviews gained' row when none was claimed (a first report), and has it when one was", () => {
    const rows = (v: ReturnType<typeof view>) => strings(v).join(" | ");
    expect(rows(view({ previousRankAsOf: null, gbp: { rating: 4.7, reviewCount: 43, reviewsGained: null, ratingChange: 0.2 } }))).not.toMatch(/gained|since the previous check/i);
    expect(rows(view())).toMatch(/Reviews gained/);
  });

  it("gives each term a grid of three rows of three cells, row by row from the north-west", () => {
    const [first, second] = view().terms;
    expect(first.heading).toBe("drain cleaning in Tigard");
    expect(first.rows).toEqual([["1-3", "1-3", "4-10"], ["4-10", "4-10", "4-10"], ["4-10", "4-10", "4-10"]]);
    expect(second.heading).toBe("water heater repair");
    expect(second.rows).toEqual([["1-3", "1-3", "1-3"], ["4-10", "4-10", "4-10"], ["not checked", "not checked", "not checked"]]);
  });

  it("maps the nine cells: 2 to 1-3, 7 to 4-10, 15 to 11-20, not found to not in the top 20, not measured to not checked", () => {
    const points = [{ pos: 2, ok: true }, { pos: 7, ok: true }, { pos: 15, ok: true }, { pos: null, ok: true }, { pos: null, ok: false }, { pos: 1, ok: true }, { pos: 20, ok: true }, { pos: 4, ok: true }, { pos: null, ok: true }];
    const v = view({ terms: [{ term: "t", town: null, points, measured: 8, visible: 2, previousVisible: null }] });
    expect(v.terms[0].rows).toEqual([["1-3", "4-10", "11-20"], ["not in the top 20", "not checked", "1-3"], ["11-20", "4-10", "not in the top 20"]]);
  });

  it("fills a short list of points with not checked, so the grid is always nine cells", () => {
    const v = view({ terms: [{ term: "t", town: null, points: [{ pos: 2, ok: true }], measured: 1, visible: null, previousVisible: null }] });
    expect(v.terms[0].rows.flat()).toHaveLength(9);
    expect(v.terms[0].rows.flat().slice(1)).toEqual(Array(8).fill("not checked"));
  });

  it("says the ranks are in our check, from the report's date, and that the grid shows that check", () => {
    const v = view();
    expect(v.rankLine).toBe("in our check on 1 Dec");
    expect(v.gridNote).toContain("1 Dec");
    expect(v.gridNote).toMatch(/our check/);
    expect(v.gridNote).toMatch(/nine points/);
  });

  it("with no check date it says there was no check, and shows no grid note about a date", () => {
    const v = view({ rankAsOf: null, previousRankAsOf: null, terms: [{ term: "t", town: null, points: Array(9).fill({ pos: null, ok: false }), measured: 0, visible: null, previousVisible: null }] });
    expect(v.rankLine).toBeNull();
    expect(v.gridNote).toMatch(/no rank check/i);
    expect(v.terms[0].rows.flat().every((c) => c === "not checked")).toBe(true);
  });

  it("a first report shows no movement text; a later one compares only what was measured both times", () => {
    const first = view({ previousRankAsOf: null, terms: [{ term: "t", town: null, points: nine(2), measured: 9, visible: 2, previousVisible: null }] });
    expect(first.terms[0].movement).toBeNull();
    expect(first.firstCheck).toBe(true);
    expect(strings(first).join(" ")).not.toMatch(/better|worse|improv|up from|down from|compared/i);

    const later = view();
    expect(later.firstCheck).toBe(false);
    expect(later.terms[0].movement).toBe("In the check on 1 Nov, 5 points were in the top 3.");
    expect(view({ terms: [{ term: "t", town: null, points: nine(2), measured: 9, visible: 2, previousVisible: 1 }] }).terms[0].movement).toBe("In the check on 1 Nov, 1 point was in the top 3.");
    // Not enough points to count, or nothing to compare with: no movement.
    expect(later.terms[1].movement).toBeNull();
    const none = view({ terms: [{ term: "t", town: null, points: nine(2), measured: 9, visible: 2, previousVisible: null }] });
    expect(none.terms[0].movement).toBeNull();
  });

  it("states in plain words how many points were in the top 3, and that too few measured points are not counted", () => {
    const v = view();
    expect(v.terms[0].summaryLine).toBe("In the top 3 at 2 of 9 points.");
    expect(v.terms[1].summaryLine).toMatch(/not enough points were checked/i);
  });

  it("reads the profile and the work done in plain words, and leaves out what was not measured", () => {
    const v = view();
    expect(v.profile).toEqual([
      { label: "Rating", value: "4.7 out of 5" }, { label: "Reviews", value: "43" }, { label: "Reviews gained", value: "3 since the previous check" },
      { label: "New reviews seen this month", value: "3" }, { label: "Replies posted", value: "2" },
    ]);
    const bare = view({ gbp: { rating: null, reviewCount: null, reviewsGained: null, ratingChange: null }, reviews: { seen: 0, posted: 0 } });
    expect(bare.profile).toEqual([{ label: "New reviews seen this month", value: "0" }, { label: "Replies posted", value: "0" }]);
    const gained = view({ gbp: { rating: 4.1, reviewCount: 10, reviewsGained: 0, ratingChange: null } });
    expect(gained.profile).toContainEqual({ label: "Reviews gained", value: "None since the previous check" });
    expect(gained.profile.some((r) => r.label === "Rating change")).toBe(false);
  });

  it("lists the content published by its titles, as plain text, and says so when there is none", () => {
    expect(view().content.titles).toEqual([{ kind: "Page", title: "Drain cleaning in Tigard" }, { kind: "Google post", title: "<b>Winter</b> tips" }]);
    expect(view({ content: { published: [] } }).content).toEqual({ titles: [], line: "Nothing was published this month." });
    expect(view().content.line).toBe("2 pieces were published this month.");
    expect(view({ content: { published: [{ kind: "post", title: "One" }] } }).content.line).toBe("1 piece was published this month.");
  });

  it("reads the directory counts, and nothing when the client has no list", () => {
    expect(view().citations).toEqual([{ label: "Confirmed", value: "6" }, { label: "Need fixing", value: "2" }, { label: "Still to do", value: "4" }]);
    expect(view({ citations: null }).citations).toEqual([]);
  });

  it("carries the summary, the recommendation and the priorities as they are, and drops an empty one", () => {
    const v = view();
    expect(v.summary).toBe("In our check the business showed up at two points.");
    expect(v.recommendation).toBe("Ask for reviews.");
    expect(v.priorities).toEqual(["Answer the low review", "Fix the address", "Publish the water heater page"]);
    const plain = view({ recommendation: "", priorities: [] });
    expect(plain.recommendation).toBe("");
    expect(plain.priorities).toEqual([]);
    expect(view({ priorities: ["a", "b", "c", "d"] }).priorities).toEqual(["a", "b", "c"]);
  });

  it("no sentence of ours holds the word guarantee, promise or a claim about the future", () => {
    for (const p of [page(), page({ previousRankAsOf: null }), page({ rankAsOf: null, terms: [] }), page({ citations: null, priorities: [] })]) {
      const v = seoReportPageView(p, { summary: "", recommendation: "", priorities: [] });
      const text = strings(v).join("\n");
      expect(text).not.toMatch(/guarantee|promise|will rank|will be|#1|number one/i);
    }
  });

  it("dates read as day and month", () => {
    const v = view({ rankAsOf: "2026-12-09", previousRankAsOf: "2026-11-30" });
    expect(v.rankLine).toBe("in our check on 9 Dec");
    expect(v.terms[0].movement).toContain("30 Nov");
  });
});
