import { describe, expect, it } from "vitest";
import {
  boardReportLine, citationLabel, contentByMonth, contentCopy, contentStatusLabel, gridCells, hasSeoPlan, keywordLimitLeft, kindLabel, movement, napPartLine, replyStatusLabel, reportWordsForm, sortReviews, starsLabel, termMovement, wordsReady,
} from "../src/client/seoView";

const pt = (pos: number | null, ok = true) => ({ pos, ok });

describe("gridCells", () => {
  it("bands each point and tones it", () => {
    const cells = gridCells([1, 5, 12, null, 3, 20, 8, 2, 19].map((p) => pt(p)));
    expect(cells.map((c) => c.label)).toEqual(["1-3", "4-10", "11-20", "not in the top 20", "1-3", "11-20", "4-10", "1-3", "11-20"]);
    expect(cells.map((c) => c.tone)).toEqual(["good", "mid", "low", "none", "good", "low", "mid", "good", "low"]);
  });
  it("says a point that was not measured is not checked, never not found", () => {
    const cells = gridCells([pt(null, false), pt(null, true), pt(2, false)]);
    expect(cells[0]).toEqual({ label: "not checked", tone: "unmeasured" });
    expect(cells[1]).toEqual({ label: "not in the top 20", tone: "none" });
    expect(cells[2]).toEqual({ label: "not checked", tone: "unmeasured" });
  });
  it("always gives nine cells: a short list is filled with not checked, a long one is cut", () => {
    expect(gridCells([])).toHaveLength(9);
    expect(gridCells([pt(1)]).slice(1).every((c) => c.tone === "unmeasured")).toBe(true);
    expect(gridCells(Array.from({ length: 12 }, () => pt(1)))).toHaveLength(9);
  });
  it("treats a position past 20 or one that is not a whole number as not in the top 20, or not checked", () => {
    expect(gridCells([pt(21)])[0]).toEqual({ label: "not in the top 20", tone: "none" });
    expect(gridCells([pt(Number.NaN)])[0]).toEqual({ label: "not in the top 20", tone: "none" });
    expect(gridCells([undefined as unknown as { pos: number | null; ok: boolean }])[0].tone).toBe("unmeasured");
  });
});

describe("movement", () => {
  it("is the first check when there is nothing earlier", () => {
    expect(movement(5, null)).toBe("first check");
  });
  it("counts points of nine, with a sign", () => {
    expect(movement(5, 3)).toBe("+2 points of 9");
    expect(movement(3, 5)).toBe("-2 points of 9");
    expect(movement(4, 3)).toBe("+1 point of 9");
    expect(movement(3, 4)).toBe("-1 point of 9");
  });
  it("says no change for the same number, zero included", () => {
    expect(movement(3, 3)).toBe("no change");
    expect(movement(0, 0)).toBe("no change");
  });
  it("is not comparable when this check could not be measured", () => {
    expect(movement(null, 3)).toBe("not comparable");
    expect(movement(null, null)).toBe("not comparable");
  });
});

describe("termMovement", () => {
  it("reads the row's own previous check", () => {
    expect(termMovement({ visible: 5, previous: null })).toBe("first check");
    expect(termMovement({ visible: 5, previous: { takenOn: "2026-11-01", visible: 3 } })).toBe("+2 points of 9");
    expect(termMovement({ visible: 5, previous: { takenOn: "2026-11-01", visible: null } })).toBe("not comparable");
    expect(termMovement({ visible: null, previous: null })).toBe("not comparable");
  });
});

describe("keywordLimitLeft", () => {
  it("is ten minus the active ones, and never below zero", () => {
    expect(keywordLimitLeft([])).toBe(10);
    expect(keywordLimitLeft(Array.from({ length: 4 }, () => ({ active: true })))).toBe(6);
    expect(keywordLimitLeft(Array.from({ length: 10 }, () => ({ active: true })))).toBe(0);
    expect(keywordLimitLeft(Array.from({ length: 12 }, () => ({ active: true })))).toBe(0);
  });
  it("ignores the ones switched off", () => {
    const ks = [...Array.from({ length: 10 }, () => ({ active: true })), ...Array.from({ length: 5 }, () => ({ active: false }))];
    expect(keywordLimitLeft(ks)).toBe(0);
    expect(keywordLimitLeft([{ active: false }, { active: true }])).toBe(9);
  });
});

describe("words for status values", () => {
  it("says each reply status in plain words", () => {
    expect(replyStatusLabel("new")).toBe("No reply yet");
    expect(replyStatusLabel("drafting")).toBe("Claude is writing a reply");
    expect(replyStatusLabel("drafted")).toBe("Reply ready for you");
    expect(replyStatusLabel("posted")).toBe("You posted it");
    expect(replyStatusLabel("skipped")).toBe("Skipped");
  });
  it("says each content status and kind", () => {
    expect(contentStatusLabel("planned")).toBe("Planned");
    expect(contentStatusLabel("drafting")).toBe("Claude is writing it");
    expect(contentStatusLabel("drafted")).toBe("Ready for you to look at");
    expect(contentStatusLabel("approved")).toBe("Approved, not on the site yet");
    expect(contentStatusLabel("published")).toBe("You put it live");
    expect(contentStatusLabel("rejected")).toBe("Rejected");
    expect(kindLabel("page")).toBe("Page");
    expect(kindLabel("post")).toBe("Blog post");
    expect(kindLabel("gbp_post")).toBe("Google post");
  });
  it("says each directory status", () => {
    expect(citationLabel("todo")).toBe("To do");
    expect(citationLabel("listed")).toBe("Listed");
    expect(citationLabel("needs_fix")).toBe("Needs fixing");
    expect(citationLabel("not_applicable")).toBe("Not applicable");
  });
  it("says a name, address and phone result part by part", () => {
    expect(napPartLine("Phone", "match")).toBe("Phone: matches the listing");
    expect(napPartLine("Address", "mismatch")).toBe("Address: differs from the listing");
    expect(napPartLine("Name", "missing")).toBe("Name: not found on the site");
  });
  it("gives a rating in words", () => {
    expect(starsLabel(5)).toBe("5 of 5 stars");
    expect(starsLabel(1)).toBe("1 of 5 stars");
  });
});

describe("sortReviews", () => {
  it("puts a drafted reply first, then a low rating still waiting, then the other open ones, then the settled ones, newest first inside each", () => {
    const rs = [
      { id: "a", replyStatus: "posted", flagged: false }, { id: "b", replyStatus: "new", flagged: false }, { id: "c", replyStatus: "new", flagged: true },
      { id: "d", replyStatus: "drafted", flagged: false }, { id: "e", replyStatus: "skipped", flagged: true }, { id: "f", replyStatus: "drafted", flagged: true },
    ] as const;
    expect(sortReviews([...rs]).map((r) => r.id)).toEqual(["d", "f", "c", "b", "a", "e"]);
  });
});

describe("boardReportLine", () => {
  it("says where last month's report stands", () => {
    expect(boardReportLine(null, "2026-11")).toBe("November 2026: not started");
    expect(boardReportLine({ period: "2026-11", status: "collecting" }, "2026-11")).toBe("November 2026: collecting numbers");
    expect(boardReportLine({ period: "2026-11", status: "ready" }, "2026-11")).toBe("November 2026: ready to send");
    expect(boardReportLine({ period: "2026-11", status: "sent" }, "2026-11")).toBe("November 2026: sent");
    expect(boardReportLine({ period: "2026-11", status: "revoked" }, "2026-11")).toBe("November 2026: taken back");
  });
});

describe("the report words form", () => {
  const row = (o: Partial<{ summary: string; recommendation: string; priorities: string[]; source: "none" | "claude" | "plain" | "logan" }> = {}) => ({
    summary: "Local SEO report for November 2026.", recommendation: "", priorities: [] as string[], source: "plain" as const, ...o,
  });
  it("for a plain summary pre-fills the summary and asks for a recommendation and three priorities", () => {
    const f = reportWordsForm(row());
    expect(f.summary).toBe("Local SEO report for November 2026.");
    expect(f.recommendation).toBe("");
    expect(f.priorities).toEqual(["", "", ""]);
    expect(f.needsMore).toBe(true);
    expect(f.note).toMatch(/recommendation and exactly three priorities are needed before it can be saved/i);
  });
  it("for Claude's or Logan's words fills everything and needs nothing more", () => {
    const f = reportWordsForm(row({ source: "claude", summary: "S", recommendation: "R", priorities: ["a", "b", "c"] }));
    expect(f).toMatchObject({ summary: "S", recommendation: "R", priorities: ["a", "b", "c"], needsMore: false, note: "" });
  });
  it("always has three priority boxes, and cuts a longer list", () => {
    expect(reportWordsForm(row({ source: "claude", summary: "S", recommendation: "R", priorities: ["a"] })).priorities).toEqual(["a", "", ""]);
    expect(reportWordsForm(row({ source: "claude", summary: "S", recommendation: "R", priorities: ["a", "b", "c", "d"] })).priorities).toEqual(["a", "b", "c"]);
  });
  it("is ready to save only with a summary, a recommendation and three priorities, all with words in them", () => {
    expect(wordsReady({ summary: "S", recommendation: "R", priorities: ["a", "b", "c"] })).toBe(true);
    expect(wordsReady({ summary: "S", recommendation: "R", priorities: ["a", "b", " "] })).toBe(false);
    expect(wordsReady({ summary: "S", recommendation: "", priorities: ["a", "b", "c"] })).toBe(false);
    expect(wordsReady({ summary: " ", recommendation: "R", priorities: ["a", "b", "c"] })).toBe(false);
    expect(wordsReady({ summary: "S", recommendation: "R", priorities: ["a", "b"] })).toBe(false);
  });
});

describe("content helpers", () => {
  it("copies a Google post as its body and a page or post as title then body", () => {
    expect(contentCopy({ kind: "gbp_post", title: "T", body: "B" })).toBe("B");
    expect(contentCopy({ kind: "page", title: "T", body: "B" })).toBe("T\n\nB");
    expect(contentCopy({ kind: "post", title: "T", body: "B" })).toBe("T\n\nB");
  });
  it("groups by month, newest first, keeping the order inside a month", () => {
    const g = contentByMonth([{ period: "2026-10", id: 1 }, { period: "2026-11", id: 2 }, { period: "2026-10", id: 3 }, { period: "2026-11", id: 4 }]);
    expect(g.map((x) => [x.period, x.label, x.items.map((i) => i.id)])).toEqual([["2026-11", "November 2026", [2, 4]], ["2026-10", "October 2026", [1, 3]]]);
  });
});

describe("hasSeoPlan", () => {
  it("is true for a live Local SEO plan of either kind", () => {
    expect(hasSeoPlan([{ packageKey: "local_seo", status: "active" }])).toBe(true);
    expect(hasSeoPlan([{ packageKey: "care", status: "active" }, { packageKey: "local_seo_growth", status: "past_due" }])).toBe(true);
  });
  it("is false for no plan, another plan, an ended one, or a rehearsal one", () => {
    expect(hasSeoPlan([])).toBe(false);
    expect(hasSeoPlan([{ packageKey: "care", status: "active" }])).toBe(false);
    expect(hasSeoPlan([{ packageKey: "local_seo", status: "cancelled" }])).toBe(false);
    expect(hasSeoPlan([{ packageKey: "local_seo", status: "active", test: true }])).toBe(false);
  });
});
